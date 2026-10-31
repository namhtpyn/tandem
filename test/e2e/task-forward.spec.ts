// Forward verb gating (#92): the workflow drawer must render Forward ONLY where
// the server accepts it — the task waits for an answer AND the viewer is the
// pending answer obligation's holder. It used to render in ready/working/paused
// states (where the server always rejects with 'task is not waiting for an
// answer') and hide in the only legal state — dead UI. Round-trip asserted:
// ask → holder forwards → obligation moves → in-chain member answers.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test('forward renders holder+waiting-answer scoped and moves the obligation', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const peerName = `E2e Fwd Peer ${suffix}`;
  const taskTitle = `FWD ${suffix}`;

  // a forward target BELOW Admin — the server refuses the top of the hierarchy
  await tasks.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(peerName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-fwd-${suffix}@tandem.local`);
  const humanRadio = page.getByRole('radio', { name: /Human/ });
  if (await humanRadio.isVisible().catch(() => false)) await humanRadio.check();
  await page.getByPlaceholder('Job title').fill('Peer');
  // supervisor = Admin: without one the target IS the top of the hierarchy and
  // forward would refuse them
  await page.getByText('No supervisors').click();
  await page.getByRole('option', { name: 'Admin', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.locator('tr:visible', { hasText: peerName })).toBeVisible({ timeout: 15_000 });

  // human-assignee task moved into a working state
  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });

  // REGRESSION (#92): while merely working the drawer renders submit + cancel,
  // NEVER Forward — the server rejects it there
  let drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByRole('button', { name: 'Submit for review' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Forward' })).toHaveCount(0);
  await expect(drawer.getByLabel('Forward to')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  // Ask is an agent verb — drive the envelope question via the session's RPC:
  // the task parks waiting-answer with the pending answer obligation on the
  // owner (= Admin, this session)
  await row.getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop()!;
  const asked = await page.request.post('/rpc/tasks/ask', {
    data: { json: { taskId, body: 'which database?' } },
  });
  expect(asked.status()).toBe(200);

  await tasks.navigate('/tasks');
  drawer = await tasks.openWorkflowDrawer(tasks.rowFor(taskTitle));
  // the only legal state: holder + waiting-answer → Forward IS rendered
  await expect(drawer.getByLabel('Forward to')).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole('button', { name: 'Forward' })).toBeVisible();

  // forward through the UI: the obligation moves to the peer
  await drawer.getByLabel('Forward to').click();
  await page.getByRole('option', { name: peerName }).first().click();
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: 'Forward' }).click();
  await expect(drawer.getByText('Forwarded', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByText(`Waiting on ${peerName}`)).toBeVisible({ timeout: 10_000 });
  // the verb moved WITH the obligation — the session is no longer the holder
  await expect(drawer.getByRole('button', { name: 'Forward' })).toHaveCount(0, { timeout: 10_000 });
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  // answer round-trip: the asker (still in the chain) answers via the composer
  drawer = await tasks.openWorkflowDrawer(tasks.rowFor(taskTitle));
  await drawer.getByLabel('Task note').fill('postgres, port 55432');
  await drawer.getByRole('button', { name: 'Send answer' }).click();
  await expect(drawer.getByText('Answer sent')).toBeVisible({ timeout: 10_000 });
  // waiting-answer ended: no holder line, task back to To do
  await expect(drawer.getByText(/Waiting on/)).toHaveCount(0, { timeout: 10_000 });
  await expect(drawer.getByText('To do', { exact: true })).toBeVisible({ timeout: 10_000 });
});
