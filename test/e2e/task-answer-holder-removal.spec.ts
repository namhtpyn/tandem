// ANSWER-ROLE REMOVAL (#369): deleting the employee who currently holds a task's
// PENDING answer obligation must never strand the task in waiting-answer with an
// obligation nothing can answer, forward or abandon. The removal captures the
// obligation read-only, cancels it after the delete commits, returns the task to
// its flow (todo — no live review round) and leaves ONE thread note naming the
// removal. Round-trip: ask → forward the question to a peer → delete the peer →
// the task is back in To do with the note visible on its page.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test('deleting the answer holder returns the waiting task to todo with a thread note', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const peerName = `E2e Ans Peer ${suffix}`;
  const taskTitle = `ANS ${suffix}`;

  // a forward target BELOW Admin — the server refuses the top of the hierarchy
  await tasks.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(peerName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-ans-${suffix}@tandem.local`);
  const humanRadio = page.getByRole('radio', { name: /Human/ });
  if (await humanRadio.isVisible().catch(() => false)) await humanRadio.check();
  await page.getByPlaceholder('Job title').fill('Answerer');
  // supervisor = Admin: without one the target IS the top of the hierarchy and
  // forward would refuse them
  await page.getByText('No supervisors').click();
  await page.getByRole('option', { name: 'Admin', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  const keySaved = page.getByRole('button', { name: /Done, key saved/ });
  if (await keySaved.isVisible().catch(() => false)) await keySaved.click();
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

  // Ask is an agent verb — drive the envelope question via the session's RPC: the
  // task parks waiting-answer with the pending answer obligation on the owner (= Admin)
  await row.getByRole('link', { name: taskTitle }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop()!;
  const asked = await page.request.post('/rpc/tasks/ask', {
    data: { json: { taskId, body: 'which database?' } },
  });
  expect(asked.status()).toBe(200);

  // forward through the drawer: the obligation moves to the PEER — they are now the
  // only holder, and deleting them is the strand this spec pins
  await tasks.navigate('/tasks');
  const drawer = await tasks.openWorkflowDrawer(tasks.rowFor(taskTitle));
  await drawer.getByLabel('Forward to').click();
  await page.getByRole('option', { name: peerName }).first().click();
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: 'Forward' }).click();
  await expect(drawer.getByText(`Waiting on ${peerName}`)).toBeVisible({ timeout: 10_000 });
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  // delete the holder mid-question
  await tasks.navigate('/employees');
  await page
    .locator('tr:visible', { hasText: peerName })
    .getByRole('button', { name: /Delete / })
    .click();
  await expect(page.getByRole('dialog').getByText(/permanently/i)).toBeVisible();
  await tasks.confirmDelete();
  await expect(page.locator('tr:visible', { hasText: peerName })).toHaveCount(0, { timeout: 15_000 });

  // the task returned to its flow instead of stranding in waiting-answer
  await tasks.navigate(`/tasks/${taskId}`);
  await expect(page.getByTestId('task-status-badge')).toHaveText('To do', { timeout: 15_000 });
  await expect(page.getByText('answer holder removed', { exact: false })).toBeVisible({ timeout: 15_000 });
});
