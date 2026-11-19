import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login.ts';

// Contract: SPEC.md "Probe versioning" — RESTORE-STRAND DETECTOR (#500, floor 2.78.42;
// park half #502, floor 2.78.43). The RE-KEYED-HOME arm cannot see a status re-keyed while
// its task sits BLOCKED over a LIVE round (a PENDING row on a blocked task is legal), and
// the strand DROPS at restore: the children land, resolveRestoreTarget resolves the
// re-keyed home, and the task leaves the review flow with its decision still owed. This
// spec seeds that exact live-round variant (a guard-window/regression re-key via direct
// SQL, the producer the SPEC allows) and drives the app's real restore: the unblock record
// must carry `reviewStrand`. The park half runs the same shape through the park branch,
// keyed on the park note's `homeCategoryAtPark` record.
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
    const seedParent = async (
      name: string,
      opts: { liveRound: boolean; rekey: boolean; record?: string; home?: string },
    ) => {
      // #503: 'ghost' = a floored note whose home already named no row (category null);
      // 'absent' = a pre-floor note (no homeCategory KEY); 'blank' = a floored EMPTY value,
      // which the reader treats as no record (the probe's `<> ''` guard) — all three seed
      // the same ghost home, and only 'ghost' is a record.
      const ghost = opts.record === 'ghost' || opts.record === 'absent' || opts.record === 'blank';
      const homeCategory = opts.home ?? 'in_review';
      const statusId = ghost ? null : await save({ name: `${name}-${tag}`, position: 80, category: homeCategory });
      if (statusId) createdStatuses.push(statusId);
      const homeId = statusId ?? crypto.randomUUID();
      const id = await createTask(`${name}-${tag}`);
      await sql.unsafe(`update tasks set status = $2, pre_block_status = $3, updated_at = now() where id = $1`, [
        id,
        BLOCKED,
        homeId,
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
      const payload: Record<string, unknown> = { kind: 'STATUS', autoBlocked: true, open: 1 };
      if (opts.record === 'ghost') payload.homeCategory = null;
      else if (opts.record === 'blank') payload.homeCategory = '';
      else if (opts.record !== 'absent') payload.homeCategory = opts.record ?? homeCategory;
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        messageId,
        payload,
      ]);
      // the declared producer: a re-key landing inside statuses.save's read->upsert window
      // (or a guard regression) — direct SQL reproduces the written state
      if (opts.rekey && statusId)
        await sql.unsafe(`update task_statuses set category = 'done' where id = $1`, [statusId]);
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
      ghostAtBlock: false,
      homeCategory: 'done',
      landingCategory: 'done',
      liveRound: true,
    });
    expect(records[0]!.body).toContain('REVIEW STRAND');

    // 1b. a live vote on a NON-current round still counts (#445: a superseded max round
    // must not hide an older owed vote)
    const older = await seedParent('OLDER', { liveRound: false, rekey: true });
    await sql.unsafe(
      `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at)
       values ($1, $2, $3, 1, 'PENDING', null, now() - interval '20 minutes')`,
      [`rev-old-${older.id}`, older.id, reviewer],
    );
    await sql.unsafe(
      `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
       values ($1, $2, $3, 2, 'SUPERSEDED', null, now() - interval '10 minutes', now() - interval '9 minutes')`,
      [`rev-sup-${older.id}`, older.id, reviewer],
    );
    expect(
      (await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: older.child, status: DONE } } })).status(),
    ).toBe(200);
    const olderRecords = await strandRecord(older.id);
    expect(olderRecords, 'an older-round live vote is a live decision too').toHaveLength(1);
    expect(olderRecords[0]!.payload).toMatchObject({ reviewStrand: true, liveRound: true });

    // 2. legal control: a re-key with no review decision to strand stays silent
    const quiet = await seedParent('QUIET', { liveRound: false, rekey: true });
    expect(
      (await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: quiet.child, status: DONE } } })).status(),
    ).toBe(200);
    expect(await strandRecord(quiet.id), 'no live round -> no strand record').toHaveLength(0);
    const quietAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [quiet.id])) as Array<{ status: string }>
    )[0];
    expect(quietAfter?.status, 'the quiet control still restored').toBe(quiet.statusId);

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

    // 3b. GHOST-AT-BLOCK (#503): a FLOORED block note recorded a NULL category — the block
    // committed against a home that already named no task_statuses row. The record is a
    // record of absence, and a live round restored out of the flow is the ghost-race
    // strand; the term must read it, not stay silent.
    const ghostAtBlock = await seedParent('GHOSTAT', { liveRound: true, rekey: false, record: 'ghost' });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', {
          data: { json: { id: ghostAtBlock.child, status: DONE } },
        })
      ).status(),
    ).toBe(200);
    const ghostAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [ghostAtBlock.id])) as Array<{ status: string }>
    )[0];
    expect(ghostAfter?.status, 'a ghost home falls back to the to-do restore target (#88)').toBe(TODO);
    const ghostRecords = await strandRecord(ghostAtBlock.id);
    expect(ghostRecords, 'a floored null-category record is a record (#503)').toHaveLength(1);
    expect(ghostRecords[0]!.payload).toMatchObject({
      reviewStrand: true,
      ghostAtBlock: true,
      recordedCategory: null,
      landingCategory: 'ready',
      liveRound: true,
    });
    expect(ghostRecords[0]!.payload, 'a ghost record still carries homeCategory (null)').toHaveProperty(
      'homeCategory',
      null,
    );
    expect(ghostRecords[0]!.body).toContain('REVIEW STRAND (ghost-at-block)');

    // 3c. pre-floor control: the same ghost shape with NO homeCategory KEY stays silent —
    // the note cannot say whether the home was a ghost at block time (the #491-era residual).
    // An OLDER floored note must not stand in for the key-less newest note (the read is the
    // newest note, and a "skip key-less notes" reader would resurrect the old record).
    const preFloorGhost = await seedParent('GHOSTPRE', { liveRound: true, rekey: false, record: 'absent' });
    await sql.unsafe(
      `with m as (
         insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, 'auto-blocked: 1 subtask(s) open', now() - interval '10 minutes')
         returning id
       )
       insert into task_message_activities (message_id, payload)
       select id, $3 from m`,
      [
        `block-old-${preFloorGhost.id}`,
        preFloorGhost.id,
        { kind: 'STATUS', autoBlocked: true, open: 1, homeCategory: 'done' },
      ],
    );
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', {
          data: { json: { id: preFloorGhost.child, status: DONE } },
        })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(preFloorGhost.id), 'a pre-floor note is not a record').toHaveLength(0);
    const preFloorAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [preFloorGhost.id])) as Array<{ status: string }>
    )[0];
    expect(preFloorAfter?.status, 'the control still restored').toBe(TODO);

    // 3d. blank control: a floored note with an EMPTY homeCategory is treated as no record
    // (the probe's `<> ''` guard), never as a ghost — same silence as the pre-floor note
    const blankGhost = await seedParent('GHOSTBLANK', { liveRound: true, rekey: false, record: 'blank' });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', {
          data: { json: { id: blankGhost.child, status: DONE } },
        })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(blankGhost.id), 'an empty value is not a ghost record').toHaveLength(0);

    // 3e. the NEWEST block note is the record: a task that blocked twice carries an OLDER
    // note whose category differs from the home — an oldest-first read would fire; the
    // newest note (recorded == home) is the current episode and stays silent.
    const newestNote = await seedParent('NEWEST', {
      liveRound: true,
      rekey: false,
      home: 'done',
      record: 'done',
    });
    await sql.unsafe(
      `with m as (
         insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, 'auto-blocked: 1 subtask(s) open', now() - interval '10 minutes')
         returning id
       )
       insert into task_message_activities (message_id, payload)
       select id, $3 from m`,
      [
        `block-old-${newestNote.id}`,
        newestNote.id,
        { kind: 'STATUS', autoBlocked: true, open: 1, homeCategory: 'in_review' },
      ],
    );
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', {
          data: { json: { id: newestNote.child, status: DONE } },
        })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(newestNote.id), 'the newest block note is the record').toHaveLength(0);
    const newestAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [newestNote.id])) as Array<{ status: string }>
    )[0];
    expect(newestAfter?.status, 'the control restored into its done-category home').toBe(newestNote.statusId);

    // 4. the PARK half (#502): the same read->upsert re-key can land while the task sits
    // PARKED — the restore takes the park branch, lands on the re-keyed home, and the
    // parked round can never settle. The park note's `homeCategoryAtPark` record is the
    // park half's ordering anchor + recorded category, exactly like the block note's.
    const seedParked = async (name: string, opts: { liveRound: boolean; rekey: boolean; record?: boolean }) => {
      const statusId = await save({ name: `${name}-${tag}`, position: 90, category: 'in_review' });
      createdStatuses.push(statusId);
      const id = await createTask(`${name}-${tag}`);
      // a LADDER-owned park (scheduled rung) is the only park the automatic restore resumes
      await sql.unsafe(
        `update tasks set status = $2, park_from_status = $3, park_rearm_after = now() + interval '1 hour',
                updated_at = now()
          where id = $1`,
        [id, BLOCKED, statusId],
      );
      if (opts.liveRound) {
        await sql.unsafe(
          `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at)
           values ($1, $2, $3, 1, 'PENDING', null, now() - interval '10 minutes')`,
          [`rev-park-${id}`, id, reviewer],
        );
      }
      const messageId = `park-${id}`;
      await sql.unsafe(
        `insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, $3, now() - interval '5 minutes')`,
        [messageId, id, 'review parked — review turn timed out'],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        messageId,
        {
          kind: 'STATUS',
          reviewParked: true,
          why: 'review turn timed out',
          fromStatus: BLOCKED,
          ...(opts.record === false ? {} : { homeCategoryAtPark: 'in_review' }),
        },
      ]);
      if (opts.rekey) await sql.unsafe(`update task_statuses set category = 'done' where id = $1`, [statusId]);
      const child = await createTask(`${name}-child-${tag}`, id);
      return { id, statusId, child };
    };

    const parkedStrand = await seedParked('PARKSTRAND', { liveRound: true, rekey: true });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedStrand.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    const parkedAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [parkedStrand.id])) as Array<{ status: string }>
    )[0];
    expect(parkedAfter?.status, 'the park restore lands the re-keyed home').toBe(parkedStrand.statusId);
    const parkedRecords = await strandRecord(parkedStrand.id);
    expect(parkedRecords, 'the park half records the strand on the restore note').toHaveLength(1);
    expect(parkedRecords[0]!.payload).toMatchObject({
      reviewStrand: true,
      parkResumed: true,
      recordedCategory: 'in_review',
      homeCategory: 'done',
      landingCategory: 'done',
      liveRound: true,
    });

    // 4b. legal control: a park restored into its still-in-review home resumes the round
    const parkedLegal = await seedParked('PARKLEGAL', { liveRound: true, rekey: false });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedLegal.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(parkedLegal.id), 'a legal park restore writes no strand').toHaveLength(0);
    const parkedLegalAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [parkedLegal.id])) as Array<{ status: string }>
    )[0];
    expect(parkedLegalAfter?.status, 'the park restore resumes into the recorded home').toBe(parkedLegal.statusId);

    // 4c. pre-floor control: a park note with no homeCategoryAtPark record stays silent
    const parkedPreFloor = await seedParked('PARKPRE', { liveRound: true, rekey: true, record: false });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedPreFloor.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(parkedPreFloor.id), 'a pre-floor park note is the declared residual').toHaveLength(0);
    const parkedPreFloorAfter = (
      (await sql.unsafe(`select status from tasks where id = $1`, [parkedPreFloor.id])) as Array<{ status: string }>
    )[0];
    expect(parkedPreFloorAfter?.status, 'the record-less park still restores into its recorded home').toBe(
      parkedPreFloor.statusId,
    );

    // 4d. the NEWEST park note is the record (#502 r5): a flapping reviewer leaves several
    // `review parked` notes (one per ladder re-fire). Seed an OLDER record-less note on a
    // re-keyed, live-round task whose CURRENT park note is floored — an oldest-first read
    // would return the record-less note, stay silent, and disable the park half for every
    // re-parked task; the newest-note read fires.
    const parkedMulti = await seedParked('PARKMULTI', { liveRound: true, rekey: true });
    await sql.unsafe(
      `with m as (
         insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, 'review parked — earlier episode', now() - interval '30 minutes')
         returning id
       )
       insert into task_message_activities (message_id, payload)
       select id, $3 from m`,
      [`park-old-${parkedMulti.id}`, parkedMulti.id, { kind: 'STATUS', reviewParked: true }],
    );
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedMulti.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    const multiRecords = await strandRecord(parkedMulti.id);
    expect(multiRecords, 'the newest park note is the record, not the oldest').toHaveLength(1);
    expect(multiRecords[0]!.payload).toMatchObject({ reviewStrand: true, recordedCategory: 'in_review' });
    // 4e. EPISODE ANCHOR (#506): a verdict that landed while the task sat BLOCKED (after
    // the episode's block record) and whose settle flip was lost, followed by a park that
    // records the home afresh — the verdict is OLDER than the park note, so only the
    // recorded episode anchor can read it as late.
    const seedParkedSettled = async (
      name: string,
      opts: { episode: boolean; verdictMinutesAgo: number; fromStatus: string },
    ) => {
      const statusId = await save({ name: `${name}-${tag}`, position: 91, category: 'in_review' });
      createdStatuses.push(statusId);
      const id = await createTask(`${name}-${tag}`);
      await sql.unsafe(
        `update tasks set status = $2, park_from_status = $3, park_rearm_after = now() + interval '1 hour',
                updated_at = now()
          where id = $1`,
        [id, BLOCKED, statusId],
      );
      const blockId = `blk-${id}`;
      const blockAt = new Date(Date.now() - 20 * 60_000);
      await sql.unsafe(
        `insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, 'auto-blocked: 1 subtask(s) open', $3)`,
        [blockId, id, blockAt],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        blockId,
        { kind: 'STATUS', autoBlocked: true, open: 1, homeCategory: 'in_review' },
      ]);
      await sql.unsafe(
        `insert into task_reviews (id, task_id, reviewer_id, round, status, source, created_at, decided_at)
         values ($1, $2, $3, 1, 'APPROVED', null, $4, $4)`,
        [`rev-506-${id}`, id, reviewer, new Date(Date.now() - opts.verdictMinutesAgo * 60_000)],
      );
      const parkId = `park-${id}`;
      await sql.unsafe(
        `insert into task_messages (id, task_id, author_id, body, created_at)
         values ($1, $2, null, 'review parked — lost settle', now() - interval '5 minutes')`,
        [parkId, id],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        parkId,
        {
          kind: 'STATUS',
          reviewParked: true,
          why: 'lost settle',
          fromStatus: opts.fromStatus,
          homeCategoryAtPark: 'in_review',
          ...(opts.episode ? { episodeBlock: { id: blockId, at: blockAt.toISOString() } } : {}),
        },
      ]);
      await sql.unsafe(`update task_statuses set category = 'done' where id = $1`, [statusId]);
      const child = await createTask(`${name}-child-${tag}`, id);
      return { id, statusId, child };
    };

    const parkedLost = await seedParkedSettled('PARK506', {
      episode: true,
      verdictMinutesAgo: 15,
      fromStatus: BLOCKED,
    });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedLost.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    const lostRecords = await strandRecord(parkedLost.id);
    expect(lostRecords, 'the recorded episode anchor reads the pre-park verdict').toHaveLength(1);
    expect(lostRecords[0]!.payload).toMatchObject({ reviewStrand: true, lateVerdict: true, liveRound: false });

    // 4f. a verdict that closed the round BEFORE this episode's block stays silent
    const parkedPreEpisode = await seedParkedSettled('PARK506PRE', {
      episode: true,
      verdictMinutesAgo: 25,
      fromStatus: BLOCKED,
    });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', {
          data: { json: { id: parkedPreEpisode.child, status: DONE } },
        })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(parkedPreEpisode.id), 'a pre-episode verdict is not late').toHaveLength(0);

    // 4g. NO anchor on the note keeps the park-record ordering — an old block note on the
    // task is never read post hoc (the statuses.remove re-home could launder a legal park)
    const parkedPure = await seedParkedSettled('PARK506PURE', {
      episode: false,
      verdictMinutesAgo: 15,
      fromStatus: 'in_review',
    });
    expect(
      (
        await page.request.post('/rpc/tasks/setStatus', { data: { json: { id: parkedPure.child, status: DONE } } })
      ).status(),
    ).toBe(200);
    expect(await strandRecord(parkedPure.id), 'no episode anchor, no post-hoc block read').toHaveLength(0);
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
