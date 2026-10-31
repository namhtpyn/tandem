// E2E: the feature-flag end-to-end (#111, SPEC: Settings > Feature flags) —
// settings-backed `tasks.turnDurations` flag: off by default (no durations),
// invalid flag writes rejected before any write, flipping the flag on renders
// settled run-turn durations WITHOUT a redeploy, running turns stay unlabeled.
// Runs are seeded straight into the e2e db (a real dispatch needs an agent);
// the thread reads whatever settled runs exist.
// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

const SETTING_FLAG = { 'tasks.turn-durations': true };

// flip flags via oRPC with the browser session's cookies (page.request rides
// the context); ALWAYS resets to an empty map — settings rows outlive the
// cleanup sweep and a leaked flag changes every later spec
async function setFlags(page: import('@playwright/test').Page, flags: Record<string, boolean>) {
  const res = await page.request.post('/rpc/settings/update', { data: { json: { flags } } });
  return res.status();
}

test('turn durations: off by default, bad writes rejected, flag flip renders settled spans', async ({ page }) => {
  const tasks = new TasksPage(page);
  const title = `Flag durations probe ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await tasks.createTask({ title });
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop() as string;

  // seed two run turns, ONE MESSAGE EACH (the thread's message→run relation is
  // 1:1 — a real dispatch writes one message per turn): one settled 4m 05s
  // ago→1s ago, one still RUNNING. ids are explicit: schema defaults are
  // app-side (drizzle), not SQL DEFAULTs
  const settledMsg = crypto.randomUUID();
  const runningMsg = crypto.randomUUID();
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const now = new Date();
  await sql`insert into task_messages (id, task_id, body, created_at) values (${settledMsg}, ${taskId}, 'flag probe settled turn', ${now})`;
  await sql`insert into task_messages (id, task_id, body, created_at) values (${runningMsg}, ${taskId}, 'flag probe running turn', ${now})`;
  await sql`insert into task_runs (id, message_id, status, exit_code, output, started_at, finished_at)
    values (${crypto.randomUUID()}, ${settledMsg}, 'DONE', 0, 'seeded settled output', now() - interval '246 seconds', now() - interval '1 second')`;
  await sql`insert into task_runs (id, message_id, status, output, started_at)
    values (${crypto.randomUUID()}, ${runningMsg}, 'RUNNING', '', now() - interval '10 seconds')`;

  try {
    await page.goto(`/tasks/${taskId}`);
    await waitForHydration(page);
    // both turns render their headers ('Completed' + 'Working'); the flag is
    // OFF → no duration label anywhere (the raw output sits in a collapsed fold)
    await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Working').first()).toBeVisible();
    await expect(page.getByTestId('run-duration')).toHaveCount(0);

    // invalid flag name → 400 before any write (SPEC validate-first)
    expect(await setFlags(page, { 'Bad Name': true })).toBe(400);
    // over the cap → 400 before any write
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`flag${i}x`, true]));
    expect(await setFlags(page, tooMany)).toBe(400);
    // still off — the rejected writes persisted nothing
    await expect(page.getByTestId('run-duration')).toHaveCount(0);

    // the real flip: on without a redeploy
    expect(await setFlags(page, SETTING_FLAG)).toBe(200);
    await page.reload();
    await waitForHydration(page);
    // settled turn labeled, running turn still unlabeled (no finish → no span)
    const durations = page.getByTestId('run-duration');
    await expect(durations).toHaveCount(1);
    await expect(durations.first()).toHaveText('· 4m 05s');

    // RUN-TRANSCRIPT LAW (#130 slice 2): the settled turn's transcript text is
    // NOT in the snapshot — the fold renders (hasOutput) and fetches the text
    // on first open; the RUNNING turn (empty output) renders no fold
    const outputFold = page.getByText(/Full output from/).first();
    await expect(outputFold).toBeVisible();
    await outputFold.click();
    await expect(page.getByText('seeded settled output')).toBeVisible({ timeout: 10_000 });
  } finally {
    // reset the namespace: settings rows survive the db sweep
    await setFlags(page, {}).catch(() => {});
    await sql.end();
  }
});
