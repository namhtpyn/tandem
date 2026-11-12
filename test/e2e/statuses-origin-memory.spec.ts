// Contract: SPEC.md "STATUS-ORIGIN MEMORY LAW" (#432) — a recorded machine origin
// (tasks.pre_block_status / tasks.park_from_status) is a raw id with no FK whose
// CATEGORY every reader resolves (the settle flip's machine-home term, the unblock
// restore target, the mint gate, both sweeps, the probe). A status mutation must not
// change what a recorded home means nor leave it naming no row:
//   - a removal RE-HOMES every recorded reference onto the built-in status of the SAME
//     category inside the delete's own transaction (both columns, every task row);
//   - a removal whose category has no built-in status (backlog) refuses with the count;
//   - a CATEGORY edit is refused while a BLOCKED task records the status as its home;
//   - name/colour/position edits stay free and never re-home anything.
// Without the re-home the home stops resolving: the flip's machine-home term stops
// matching, the round closes with NO task write, and the restore falls back to to-do.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login';

// Baseline status rows the e2e global setup re-seeds (test/e2e/global-setup.ts).
const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';
const BLOCKED = '01a14743-43f5-759d-a00e-ada27e46c2f8';
const IN_REVIEW = '01a14743-43f5-759d-a00e-a90831248ea5';

type Saved = { id: string };

test.describe('status origin memory (#432)', () => {
  test('removals re-home recorded homes; category edits refuse; name edits stay free', async ({ page }) => {
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
    const seedBlocked = async (taskId: string, pre: string | null, park: string | null) => {
      await sql.unsafe(
        `insert into tasks (id, title, status, pre_block_status, park_from_status, created_at, updated_at)
         values ($1, $1, $2, $3, $4, now(), now())`,
        [taskId, BLOCKED, pre, park],
      );
    };

    try {
      // (1) a removal re-homes a BLOCK origin onto the built-in status of its category
      const qa = await create(`QA ${suffix}`, 'in_review', 20);
      const blockedA = `status-origin-pre-${suffix}`;
      await seedBlocked(blockedA, qa, null);
      const removedA = await remove(qa);
      expect(removedA.status()).toBe(200);
      expect(await originOf(blockedA, 'pre_block_status'), 'the block home keeps its category').toBe(IN_REVIEW);
      createdStatuses.splice(createdStatuses.indexOf(qa), 1);

      // (2) a removal re-homes a PARK origin the same way (both columns, not just one)
      const parkedHome = await create(`Park home ${suffix}`, 'in_review', 21);
      const blockedB = `status-origin-park-${suffix}`;
      await seedBlocked(blockedB, null, parkedHome);
      const removedB = await remove(parkedHome);
      expect(removedB.status()).toBe(200);
      expect(await originOf(blockedB, 'park_from_status'), 'the park home keeps its category').toBe(IN_REVIEW);
      createdStatuses.splice(createdStatuses.indexOf(parkedHome), 1);

      // (3) a category with no built-in status refuses instead of guessing a different one
      const backlog = await create(`Bucket ${suffix}`, 'backlog', 22);
      const blockedC = `status-origin-backlog-${suffix}`;
      await seedBlocked(blockedC, backlog, null);
      const refused = await remove(backlog);
      expect(refused.status(), 'a backlog home cannot be re-homed faithfully').toBe(400);
      const refusedBody = JSON.stringify(await refused.json());
      expect(refusedBody).toContain('recorded home of 1 task');
      expect(refusedBody).toContain('backlog');
      expect(await originOf(blockedC, 'pre_block_status'), 'a refused removal touches nothing').toBe(backlog);
      const stillThere = await sql.unsafe(`select id from task_statuses where id = $1`, [backlog]);
      expect(stillThere.length, 'a refused removal deletes nothing').toBe(1);

      // (4) a CATEGORY edit is refused while a BLOCKED task records the status as its home
      const live = await create(`Live home ${suffix}`, 'ready', 23);
      const blockedD = `status-origin-cat-${suffix}`;
      await seedBlocked(blockedD, live, null);
      const { res: catEdit } = await save({ id: live, name: `Live home ${suffix}`, position: 23, category: 'done' });
      expect(catEdit.status(), 'a category edit would re-key the blocked task').toBe(400);
      expect(JSON.stringify(await catEdit.json())).toContain('recorded home of 1 blocked task');
      const kept = await sql.unsafe(`select category from task_statuses where id = $1`, [live]);
      expect((kept[0] as { category: string }).category, 'a refused edit keeps the category').toBe('ready');
      expect(await originOf(blockedD, 'pre_block_status'), 'a refused edit touches nothing').toBe(live);

      // (5) a name/colour edit on the same status stays free and re-homes nothing
      const { res: renamed } = await save({
        id: live,
        name: `Live home renamed ${suffix}`,
        position: 23,
        category: 'ready',
        color: 'info',
      });
      expect(renamed.status()).toBe(200);
      expect(await originOf(blockedD, 'pre_block_status'), 'a name edit leaves the recorded home alone').toBe(live);

      // (6) an unreferenced custom status still deletes (the guard is not over-broad)
      const spare = await create(`Spare ${suffix}`, 'in_review', 24);
      const removedSpare = await remove(spare);
      expect(removedSpare.status()).toBe(200);
      createdStatuses.splice(createdStatuses.indexOf(spare), 1);
    } finally {
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
        data: { json: { name: `Triage ${suffix}`, position: 25, category: 'ready' } },
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
