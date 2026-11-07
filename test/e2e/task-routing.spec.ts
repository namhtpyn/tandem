// E2E: task routing — "needs my decision" inbox toggle with badge, subtask creation
// with parent chip, parent auto-block while children are open (user laws, 2026-10-15).
// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { expect, test } from './helpers/cleanup';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';

test('inbox toggle filters to tasks pending on me and shows a badge', async ({ page }) => {
  const suffix = Date.now();
  const name = `Inbox toggle ${suffix}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);

  // baseline BEFORE this test creates anything: the badge counts the whole
  // workspace, so the later assert is an exact delta, not a magic number
  await expect(page.getByTestId('inbox-count-pending')).toHaveCount(0, { timeout: 10_000 });
  const inboxBadge = page.getByTestId('inbox-count');
  const inboxBefore = (await inboxBadge.count()) ? Number(await inboxBadge.textContent()) || 0 : 0;
  // absent at zero — a 0 badge would read as a count
  if (inboxBefore > 0) await expect(page.getByTestId('nav-inbox-badge')).toHaveText(String(inboxBefore));
  else await expect(page.getByTestId('nav-inbox-badge')).toHaveCount(0);

  // task assigned to admin (the logged-in user) and in progress, so Ask routes
  // the question to the owner (= admin) -> inbox obligation on the same user
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(name);
  await page.getByRole('dialog').getByRole('combobox', { name: 'Assignee', exact: true }).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();

  // flip to doing via the list's inline status select, then ask from the detail page
  await page.locator('tbody').getByLabel(`Status for ${name}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(page.locator('tr:visible').filter({ hasText: name }).first()).toContainText(/doing/i);
  await page.getByRole('link', { name: name }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  // Ask is an agent verb now (envelope question) — drive it via the session's RPC
  const taskUrl = page.url();
  const taskId = taskUrl.split('/').pop()!;
  const asked = await page.request.post('/rpc/tasks/ask', {
    data: { json: { taskId, body: 'which db?' } },
  });
  expect(asked.status()).toBe(200);

  await page.goto('/tasks');
  await waitForHydration(page);
  const toggle = page.getByTestId('needs-decision-toggle');
  await expect(toggle).toContainText('Needs my decision');
  // exact delta: this ask added exactly one pending decision
  await expect(page.getByTestId('inbox-count')).toHaveText(String(inboxBefore + 1));

  // seed a bystander the inbox must NOT show: no obligation, not pending on me
  const bystander = `Inbox bystander ${suffix}`;
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(bystander);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: bystander }).first()).toBeVisible({ timeout: 15_000 });

  // toggle on: the pending task remains, the bystander disappears
  await toggle.click();
  await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('link', { name: bystander })).toHaveCount(0);

  // DECISION-VISIBILITY LAW (#350): the toggle is URL-backed, and the shell
  // nav's Tasks item carries the same pending count from every surface
  await expect.poll(() => page.url()).toContain('inbox=1');
  await expect(page.getByTestId('nav-inbox-badge')).toHaveText(String(inboxBefore + 1));

  // the shell badge is NOT the /tasks page's own prefetch: a page with no inbox
  // query of its own still shows the count (the layout is the source)
  await page.goto('/employees');
  await waitForHydration(page);
  await expect(page.getByTestId('nav-inbox-badge')).toHaveText(String(inboxBefore + 1));

  // mobile: the sidebar is a closed drawer below lg — the navbar pill is the
  // one-tap entry to the same queue, on every page
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForHydration(page);
  const mobileBadge = page.getByTestId('nav-inbox-badge-mobile');
  await expect(mobileBadge).toHaveText(String(inboxBefore + 1));
  await mobileBadge.click();
  await expect.poll(() => page.url()).toContain('/tasks?inbox=1');
  await expect(page.getByTestId('needs-decision-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 1280, height: 720 });

  // deep link: a fresh load restores the personal queue (not just the badge)
  await page.goto('/tasks?inbox=1');
  await waitForHydration(page);
  await expect(page.getByTestId('needs-decision-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('link', { name: bystander })).toHaveCount(0);

  // drill-down round-trip: the detail URL carries the queue, Back rebuilds it
  await page.getByRole('link', { name }).first().click();
  await expect.poll(() => page.url()).toContain('inbox=1');
  await page.getByRole('link', { name: 'Back to tasks' }).first().click();
  await expect.poll(() => page.url()).toContain('/tasks?');
  await expect(page.getByTestId('needs-decision-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name })).toBeVisible();

  // AT parity: the digits are decorative; the count rides the link name as
  // words — Chrome joins element contributions with a single space
  const navTasksLink = page
    .getByRole('link', { name: new RegExp(`^Tasks( ${inboxBefore + 1} decisions? waiting on you)?$`) })
    .first();
  await expect(navTasksLink).toHaveCount(1);

  // URL is the source of truth: a query-only nav click clears the filter
  await navTasksLink.click();
  await expect.poll(() => page.url()).not.toContain('inbox=1');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('link', { name: bystander })).toBeVisible();

  // state → URL: toggling on writes the param, toggling off clears it
  await toggle.click();
  await expect.poll(() => page.url()).toContain('inbox=1');
  await toggle.click();
  await expect.poll(() => page.url()).not.toContain('inbox=1');
  await expect(toggle).toContainText('Needs my decision');
});

test('subtask creation nests under the parent, chips the child, and blocks the parent', async ({ page }) => {
  const suffix = Date.now();
  const parentName = `Gating parent ${suffix}`;
  const childName = `Gating child ${suffix}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);

  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(parentName);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: parentName }).first()).toBeVisible();
  await page.getByRole('link', { name: parentName }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });

  // create a subtask through the task creation modal (parent pre-set)
  const panel = page.getByTestId('subtask-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Add subtask' }).click();
  const subtaskModal = page.getByRole('dialog', { name: 'New subtask' });
  await expect(subtaskModal).toBeVisible();
  await subtaskModal.getByPlaceholder('Task title').fill(childName);
  await subtaskModal.getByRole('button', { name: /Create subtask/ }).click();
  await expect(panel.getByRole('link', { name: childName })).toBeVisible({ timeout: 10_000 });

  // parent flips to blocked (derived from the open child); the reload pulls
  // fresh server state and the retrying 'Blocked' assert absorbs the derive
  await page.reload();
  // status ids are uuids now — the badge renders the status NAME; scope the
  // assert to the PARENT's own header badge (a stray 'Blocked' anywhere else on
  // the page must not satisfy it)
  await expect(page.getByTestId('task-status-badge')).toHaveText('Blocked', { timeout: 10_000 });

  // child page carries the parent chip
  await panel.getByRole('link', { name: childName }).click();
  await expect(page.getByTestId('parent-task-link')).toContainText(parentName);
});
