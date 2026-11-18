import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login.ts';

// Contract: SPEC.md "Probe versioning" — RESTORE-STRAND DETECTOR (#500, floor 2.78.42).
// The RE-KEYED-HOME arm cannot see a status re-keyed while its task sits BLOCKED over a
// LIVE round (a PENDING row on a blocked task is legal), and the strand DROPS at restore:
// the children land, resolveRestoreTarget resolves the re-keyed home, and the task leaves
// the review flow with its decision still owed. This spec seeds that exact live-round
// variant (a guard-window/regression re-key via direct SQL, the producer the SPEC allows)
// and drives the app's real restore: the unblock record must carry `reviewStrand`.
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';

test('a restore into a re-keyed home with a live round records the strand (#500)', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const tag = crypto.randomUUID().slice(0, 8);
  const createdStatuses: string[] = [];
  try {
    const save = async (body: Record<string, unknown>) => {
      const res = await page.request.post('/rpc/statuses/save', { data: { json: body } });
      expect(res.status(), `statuses/save ${body.name}`).toBe(200);
      return ((await res.json()) as { json: { id: string } }).json.id;
    };
    const createTask = async (title: string, parentId?: string) => {
      const res = await page.request.post('/rpc/tasks/create', {
        data: { json: { title, ...(parentId ? { parentId } : {}) } },
      });
      expect(res.status(), `tasks/create ${title}`).toBe(200);
      const id = ((await res.json()) as { json?: { id?: string } }).json?.id;
      expect(id).toBeTruthy();
      return id!;
    };
    const reviewer = (
      (await sql.unsafe(`select id from "user" order by created_at asc limit 1`)) as Array<{ id: string }>
    )[0]!.id;

    // the flow the restore must leave behind: a parent BLOCKED with a recorded in-review
    // home, a LIVE reviewer row (minted before the block record), and a block record whose
    // homeCategory says the home was in-review when the block committed
    const seedParent = async (name: string, opts: { liveRound: boolean; rekey: boolean }) => {
      const statusId = await save({ name: `${name}-${tag}`, position: 80, category: 'in_review' });
      createdStatuses.push(statusId);
      const id = await createTask(`${name}-${tag}`);
      await sql.unsafe(`update tasks set status = $2, pre_block_status = $3, updated_at = now() where id = $1`, [
        id,
        BLOCKED,
        statusId,
      ]);
      if (opts.liveRound) {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at)
           values ($1, $2, $3, 1, 'PENDING', null, now() - interval '10 minutes')`,
          [`rev-${id}`, id, reviewer],
        );
      }
      const messageId = `block-${id}`;
      await sql.unsafe(
        `insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, $3, now() - interval '5 minutes')`,
        [messageId, id, 'auto-blocked: 1 subtask(s) open'],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        messageId,
        { kind: 'STATUS', autoBlocked: true, open: 1, homeCategory: 'in_review' },
      ]);
      // the declared producer: a re-key landing inside statuses.save's read->upsert window
      // (or a guard regression) — direct SQL reproduces the written state
      if (opts.rekey) await sql.unsafe(`update task_statuses set category = 'done' where id = $1`, [statusId]);
      const child = await createTask(`${name}-child-${tag}`, id);
      return { id, statusId, child };
    };

    const strandRecord = async (taskId: string) =>
      (await sql.unsafe(
        `select m.body, a.payload
             from task_messages m join task_message_activities a on a.message_id = m.id
            where m.task_id = $1 and a.payload->>'reviewStrand' = 'true'`,
        [taskId],
      )) as Array<{ body: string; payload: Record<string, unknown> }>;

    // 1. the live-round variant: restore must record the strand
    const stranded = await seedParent('STRAND', { liveRound: true, rekey: true });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: stranded.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    const parentAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [stranded.id])) as Array<{ status: string }>
    )[0];
    expect(parentAfter?.status, 'the restore lands the re-keyed home').toBe(stranded.statusId);
    const records = await strandRecord(stranded.id);
    expect(records, 'the restore-time detector writes the verdict on its unblock record').toHaveLength(1);
    expect(records[0]!.payload).toMatchObject({
      kind: 'STATUS',
      autoUnblocked: true,
      reviewStrand: true,
      recordedCategory: 'in_review',
      homeCategory: 'done',
      landingCategory: 'done',
      liveRound: true,
    });
    expect(records[0]!.body).toContain('REVIEW STRAND');

    // 2. legal control: a re-key with no review decision to strand stays silent
    const quiet = await seedParent('QUIET', { liveRound: false, rekey: true });
    expect(
      (await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: quiet.child, status: DONE } } })).status(),
    ).toBe(200);
    expect(await strandRecord(quiet.id), 'no live round -> no strand record').toHaveLength(0);

    // 2b. the decided variant: a verdict landed AFTER the block record while the task sat
    // blocked — the round closed, the settle flip could not land, and the restore drops it
    const late = await seedParent('LATE', { liveRound: false, rekey: true });
    await sql.unsafe(
      `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
       values ($1, $2, $3, 1, 'APPROVED', null, now() - interval '10 minutes', now() - interval '1 minute')`,
      [`rev-late-${late.id}`, late.id, reviewer],
    );
    expect(
      (await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: late.child, status: DONE } } })).status(),
    ).toBe(200);
    const lateRecords = await strandRecord(late.id);
    expect(lateRecords, 'a verdict newer than the block record is a strand too').toHaveLength(1);
    expect(lateRecords[0]!.payload).toMatchObject({ reviewStrand: true, liveRound: false, lateVerdict: true });

    // 3. legal control: a live round restored into its recorded in-review home re-enters the
    // flow (the recorded category equals the landing one) — no strand record
    const inFlow = await seedParent('INFLOW', { liveRound: true, rekey: false });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: inFlow.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(inFlow.id), 'a matching recorded category is not a strand').toHaveLength(0);
    const inFlowAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [inFlow.id])) as Array<{ status: string }>
    )[0];
    expect(inFlowAfter?.status, 'the control really restored into its recorded home').toBe(inFlow.statusId);
  } finally {
    // the per-test fixture sweeps tasks AFTER this block, but status removal refuses while
    // any task still references the status — remove this spec's rows first (tag-scoped),
    // then the statuses, so the run's custom-status set never leaks into a later spec.
    await sql.unsafe(`delete from tasks where title like '%' || $1 || '%'`, [tag]);
    for (const id of createdStatuses) {
      await page.request.post('/rpc/statuses/remove', { data: { json: { id } } }).catch(() => undefined);
    }
    await sql.close();
  }
});
