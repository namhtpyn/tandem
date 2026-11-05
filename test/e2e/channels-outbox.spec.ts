// CHANNEL REPLY RELAY e2e (#271 slice 2, SPEC: Channels — Reply relay): a run
// that settles DONE on a channel-mapped task persists one channel_outbox row
// carrying the turn's final body — persisted BEFORE any send (deploys drop
// nothing). The e2e stack starts no channel adapters (no `channels` settings
// row), so the row stays unprocessed: this spec pins the DURABILITY half
// (row lands, body is the envelope text, worker has not consumed it); the
// send/ordering/deferral half is unit-pinned in channels-outbox.test.ts.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { TasksPage } from './pages/tasks.page.ts';

/** hold the dispatcher scan off the fresh ready AI task (born-ineligible law:
 * the 5s tick would claim it mid-test); the MANUAL dispatch verb ignores the
 * hold, which is what this spec fires */
async function holdScan(taskId: string) {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId}`;
  await sql.close();
}

async function seedAiEmployee(page: import('@playwright/test').Page, tag: string): Promise<{ id: string }> {
  const env = await page.request.post('/rpc/environments/create', {
    data: { json: { name: `E2E Env ${tag}`, host: '127.0.0.1', port: '22', username: 'e2e' } },
  });
  expect(env.status()).toBe(200);
  const envId = ((await env.json()) as { json?: { id?: string } }).json?.id;
  expect(envId).toBeTruthy();
  const emp = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `E2E Bot ${tag}`,
        email: `e2e-chanrelay-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Runner',
        environmentId: envId,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  const id = ((await emp.json()) as { json?: { id?: string } }).json?.id;
  expect(id, 'employee create returns the user id').toBeTruthy();
  return { id: id as string };
}

/** attach the AI assignee AFTER the dispatch_after hold is set (born-ineligible
 * law): the task is unassigned at insert, so the scan can never claim it */
async function attachAssignee(page: import('@playwright/test').Page, taskId: string, employeeId: string) {
  const res = await page.request.post('/rpc/tasks/update', {
    data: { json: { id: taskId, assigneeId: employeeId } },
  });
  expect(res.status()).toBe(200);
}

/** seed the channel↔task mapping BEFORE dispatch: the relay reads mappings on
 * settle. Fixed ids carry the per-run tag (retry-safe even when the sweep
 * window misses); created_at is explicit (SQL-seed law: $default is app-side) */
async function seedChannelMapping(taskId: string, tag: string) {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  await sql`
    insert into channel_threads (id, channel, adapter, thread_ref, task_id, created_at, updated_at)
    values (
      ${`chan-thr-${tag}`}, 'matrix', 'matrix:https://chanrelay.example.org',
      ${`!room:${tag}:example.org`}, ${taskId}, now(), now()
    )
    on conflict do nothing
  `;
  await sql.close();
}

test('a settled DONE run on a channel-mapped task lands its reply in channel_outbox', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const bot = await seedAiEmployee(page, tag);
  const taskTitle = `CHAN RELAY ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle });
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const taskId = await row
    .locator('a[href^="/tasks/"]')
    .first()
    .getAttribute('href')
    .then((href) => (href ?? '').split('/').pop() as string);
  expect(taskId).toBeTruthy();

  // born ineligible: hold the scan, attach the AI assignee, seed the mapping
  await holdScan(taskId);
  await attachAssignee(page, taskId, bot.id);
  await seedChannelMapping(taskId, tag);

  // manual dispatch → fake runner settles DONE → the settle hook relays
  const drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByTestId('drawer-verb-dispatch')).toBeVisible({ timeout: 10_000 });
  await drawer.getByTestId('drawer-verb-dispatch').click();
  await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 15_000 });

  // the outbox row carries the turn's final body — exactly what the thread
  // turn shows (a fake run has no JSON verdict line, so the human tail is the
  // body; a real run with a {"kind":"result",...} envelope line relays the
  // verdict text instead) — and is NOT yet processed: no adapter exists in
  // e2e, the worker defers. The persist-first durability half is what this pins.
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  let relayBody: string | null = null;
  await expect
    .poll(
      async () => {
        const rows = await sql`
          select body, processed_at, adapter, thread_ref
          from channel_outbox where task_id = ${taskId}
        `;
        if (rows.length === 1) {
          relayBody = rows[0].body as string;
          return rows[0];
        }
        return null;
      },
      { timeout: 45_000, intervals: [2_000] },
    )
    .toMatchObject({
      adapter: 'matrix:https://chanrelay.example.org',
      thread_ref: `!room:${tag}:example.org`,
      processed_at: null,
    });
  expect(relayBody).toContain('RESULT: task complete as requested');
  expect(relayBody).toContain('working: step 3/3');
  const rows = await sql`
    select count(*)::int as n from channel_outbox where task_id = ${taskId}
  `;
  expect(rows[0]?.n).toBe(1); // exactly one row per mapped thread — never a double relay
  await sql.close();
});
