// Contract: SPEC.md "STATUS-ORIGIN MEMORY LAW" (#432) — a recorded machine origin
// (tasks.pre_block_status / tasks.park_from_status) is a raw id with no FK whose
// CATEGORY every reader resolves (the settle flip's machine-home term, the unblock
// restore target, the mint gate, both sweeps, the probe). A status mutation must not
// change what a recorded home means nor leave it naming no row:
//   - a removal RE-HOMES every recorded reference (both columns, every task row — a
//     stale reference on a non-paused row included) onto the live built-in status of the
//     SAME category inside the delete's own transaction;
//   - a removal whose category has no FAITHFUL built-in home refuses with the count:
//     'backlog' has no built-in row, 'paused''s only built-in IS the block state itself,
//     and a built-in that no longer carries the category (an admin can recategorize it)
//     is refused too instead of re-homing into the wrong category;
//   - the re-home is metadata repair: it must NOT bump tasks.updated_at (a bumped stamp
//     would miss an in-flight settle flip's CAS and mask the #430 wedge discriminator);
//   - a CATEGORY edit is refused while a BLOCKED task records the status as its home;
//     name/colour/position edits stay free, and stale references on non-paused rows
//     never gate an edit.
// Without the re-home the home stops resolving: the flip's machine-home term stops
// matching, the round closes with NO task write, and the restore falls back.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login';

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const DONE = '01a14743-43f5-759d-a00e-a20a36faa315';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';

type Saved = { id: string };
type StatusRow = { id: string; name: string; color: string; position: number; category: string; nextIds: string[] };

test.describe('status origin memory (#432)', () => {
  test('removals re-home recorded homes; unfaithful homes refuse; category edits are scoped', async ({ page }) => {
    await login(page);
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    const createdStatuses: string[] = [];
    const suffix = crypto.randomUUID().slice(0, 8);
    const save = async (body: Record<string, unknown>) => {
      const res = await page.request.post('/rpc/statuses/save', { data: { json: body } });
      return { res, json: (await res.json()) as { json?: Saved } };
    };
    const create = async (name: string, category: string, position: number) => {
      const { res, json } = await save({ name, position, category });
      expect(res.status(), `create ${name}`).toBe(200);
      const id = json.json!.id;
      createdStatuses.push(id);
      return id;
    };
    const remove = (id: string) => page.request.post('/rpc/statuses/remove', { data: { json: { id } } });
    const originOf = async (taskId: string, column: 'pre_block_status' | 'park_from_status') => {
      const rows = await sql.unsafe(`select ${column} as home from tasks where id = $1`, [taskId]);
      return String((rows[0] as { home?: string | null } | undefined)?.home ?? '');
    };
    const stampOf = async (taskId: string) => {
      const rows = await sql.unsafe(`select updated_at::text as stamp from tasks where id = $1`, [taskId]);
      return String((rows[0] as { stamp: string }).stamp);
    };
    const seedTask = async (
      taskId: string,
      status: string,
      home: { pre?: string | null; park?: string | null },
      writtenMinutesAgo = 0,
    ) => {
      await sql.unsafe(
        `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
         values ($1, $1, $2, $3, $4, now(), now() - ($5::int * interval '1 minute'))`,
        [taskId, status, home.pre ?? null, home.park ?? null, writtenMinutesAgo],
      );
    };
    const statusRow = async (id: string): Promise<StatusRow | undefined> =>
      (await page.request.post('/rpc/statuses/list', { data: { json: null } }).then((r) => r.json())).json.find(
        (s: StatusRow) => s.id === id,
      );

    try {
      // (1) a removal re-homes a BLOCK origin onto the built-in status of its category,
      // and the repair must not bump the row's stamp (an in-flight settle CAS pins it)
      const qa = await create(`QA ${suffix}`, 'in_review', 20);
      const blockedA = `status-origin-pre-${suffix}`;
      await seedTask(blockedA, BLOCKED, { pre: qa }, 5);
      const stampBefore = await stampOf(blockedA);
      const removedA = await remove(qa);
      expect(removedA.status()).toBe(200);
      expect(await originOf(blockedA, 'pre_block_status'), 'the block home keeps its category').toBe(IN_REVIEW);
      expect(await stampOf(blockedA), 'metadata repair holds the stamp back').toBe(stampBefore);
      createdStatuses.splice(createdStatuses.indexOf(qa), 1);

      // (2) a removal re-homes a PARK origin the same way (both columns, not just one)
      const parkedHome = await create(`Park home ${suffix}`, 'in_review', 21);
      const blockedB = `status-origin-park-${suffix}`;
      await seedTask(blockedB, BLOCKED, { park: parkedHome });
      const removedB = await remove(parkedHome);
      expect(removedB.status()).toBe(200);
      expect(await originOf(blockedB, 'park_from_status'), 'the park home keeps its category').toBe(IN_REVIEW);
      createdStatuses.splice(createdStatuses.indexOf(parkedHome), 1);

      // (3) EVERY task row is re-homed, not only paused ones: a stale origin on a
      // terminal row (#427 egress leftover) is inert but must not be left naming no row
      const staleHome = await create(`Stale home ${suffix}`, 'in_review', 22);
      const doneTask = `status-origin-stale-${suffix}`;
      await seedTask(doneTask, DONE, { pre: staleHome });
      const removedStale = await remove(staleHome);
      expect(removedStale.status()).toBe(200);
      expect(await originOf(doneTask, 'pre_block_status'), 'a stale reference is re-homed too').toBe(IN_REVIEW);
      createdStatuses.splice(createdStatuses.indexOf(staleHome), 1);

      // (4) a category with no built-in status refuses instead of guessing a different one
      const backlog = await create(`Bucket ${suffix}`, 'backlog', 23);
      const blockedC = `status-origin-backlog-${suffix}`;
      await seedTask(blockedC, BLOCKED, { pre: backlog });
      const refused = await remove(backlog);
      expect(refused.status(), 'a backlog home cannot be re-homed faithfully').toBe(400);
      const refusedBody = JSON.stringify(await refused.json());
      expect(refusedBody).toContain('recorded home of 1 task');
      expect(refusedBody).toContain('backlog');
      expect(await originOf(blockedC, 'pre_block_status'), 'a refused removal touches nothing').toBe(backlog);
      const stillThere = await sql.unsafe(`select id from task_statuses where id = $1`, [backlog]);
      expect(stillThere.length, 'a refused removal deletes nothing').toBe(1);

      // (5) 'paused' has NO faithful home either: its only built-in IS the block state,
      // and a home re-homed onto it would restore into the block and strand the row
      const held = await create(`Vendor hold ${suffix}`, 'paused', 24);
      const blockedPaused = `status-origin-paused-${suffix}`;
      await seedTask(blockedPaused, BLOCKED, { pre: held });
      const refusedPaused = await remove(held);
      expect(refusedPaused.status(), 'a paused-category home has no faithful target').toBe(400);
      expect(JSON.stringify(await refusedPaused.json())).toContain('no faithful built-in home');
      expect(await originOf(blockedPaused, 'pre_block_status'), 'the paused home survives the refusal').toBe(held);

      // (6) a CATEGORY edit is refused while a BLOCKED task records the status as its home
      const live = await create(`Live home ${suffix}`, 'ready', 25);
      const blockedD = `status-origin-cat-${suffix}`;
      await seedTask(blockedD, BLOCKED, { pre: live });
      const { res: catEdit } = await save({ id: live, name: `Live home ${suffix}`, position: 25, category: 'done' });
      expect(catEdit.status(), 'a category edit would re-key the blocked task').toBe(400);
      expect(JSON.stringify(await catEdit.json())).toContain('recorded home of 1 blocked task');
      const kept = await sql.unsafe(`select category from task_statuses where id = $1`, [live]);
      expect((kept[0] as { category: string }).category, 'a refused edit keeps the category').toBe('ready');
      expect(await originOf(blockedD, 'pre_block_status'), 'a refused edit touches nothing').toBe(live);

      // (7) a name/colour edit on the same status stays free and re-homes nothing
      const { res: renamed } = await save({
        id: live,
        name: `Live home renamed ${suffix}`,
        position: 25,
        category: 'ready',
        color: 'info',
      });
      expect(renamed.status()).toBe(200);
      expect(await originOf(blockedD, 'pre_block_status'), 'a name edit leaves the recorded home alone').toBe(live);

      // (8) a stale reference on a NON-paused row never gates a category edit
      const loose = await create(`Loose home ${suffix}`, 'ready', 26);
      const staleTask = `status-origin-loose-${suffix}`;
      await seedTask(staleTask, DONE, { pre: loose });
      const { res: looseEdit } = await save({
        id: loose,
        name: `Loose home ${suffix}`,
        position: 26,
        category: 'in_review',
      });
      expect(looseEdit.status(), 'an inert reference never blocks an edit').toBe(200);
      expect(await originOf(staleTask, 'pre_block_status'), 'an inert reference is not re-homed by an edit').toBe(
        loose,
      );

      // (9) the re-home target's LIVE category is re-verified: recategorize the built-in
      // TODO row, then a ready-category home must refuse instead of landing on it.
      // (Shared boot-seed state: restored in the finally below.)
      const todoRow = (await statusRow(TODO))!;
      const drift = await save({ ...todoRow, category: 'done' });
      expect(drift.res.status(), 'the built-in can be recategorized by an admin').toBe(200);
      const readyHome = await create(`Triage ${suffix}`, 'ready', 27);
      const blockedE = `status-origin-drift-${suffix}`;
      await seedTask(blockedE, BLOCKED, { pre: readyHome });
      const refusedDrift = await remove(readyHome);
      expect(refusedDrift.status(), 'a drifted built-in is not a faithful target').toBe(400);
      expect(await originOf(blockedE, 'pre_block_status'), 'the ready home survives the refusal').toBe(readyHome);
      await save({ ...todoRow, category: 'ready' });

      // (10) an unreferenced custom status still deletes (the guard is not over-broad)
      const spare = await create(`Spare ${suffix}`, 'in_review', 28);
      const removedSpare = await remove(spare);
      expect(removedSpare.status()).toBe(200);
      createdStatuses.splice(createdStatuses.indexOf(spare), 1);
    } finally {
      // the built-in TODO row is boot-seed state every later spec resolves (SCRATCH-SPEC
      // RESTORE LAW): put its category back even when an assertion above failed
      const todoNow = await statusRow(TODO);
      if (todoNow && todoNow.category !== 'ready') await save({ ...todoNow, category: 'ready' });
      // custom statuses are not part of the cleanup fixture's sweep and would leak into
      // later specs of the same run (global-setup re-seeds them only on the next boot)
      for (const id of createdStatuses) await sql.unsafe(`delete from task_statuses where id = $1`, [id]);
      await sql.close();
    }
  });

  // A ready-category origin is the other half of the mapping: a delete must land the
  // recorded home on THAT category's built-in row, never on in-review (a wrong category
  // would restore a plain gated task into the review flow).
  test('a ready-category home re-homes onto the built-in ready status', async ({ page }) => {
    await login(page);
    const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
    const suffix = crypto.randomUUID().slice(0, 8);
    try {
      const res = await page.request.post('/rpc/statuses/save', {
        data: { json: { name: `Triage ${suffix}`, position: 29, category: 'ready' } },
      });
      expect(res.status()).toBe(200);
      const home = ((await res.json()) as { json: Saved }).json.id;
      const blocked = `status-origin-ready-${suffix}`;
      await sql.unsafe(
        `insert into tasks (id, title, status, pre_block_status, created_at, updated_at)
         values ($1, $1, $2, $3, now(), now())`,
        [blocked, BLOCKED, home],
      );
      const removed = await page.request.post('/rpc/statuses/remove', { data: { json: { id: home } } });
      expect(removed.status()).toBe(200);
      const rows = await sql.unsafe(`select pre_block_status as home from tasks where id = $1`, [blocked]);
      expect(String((rows[0] as { home: string }).home), 'ready stays ready').toBe(TODO);
    } finally {
      await sql.close();
    }
  });
});
