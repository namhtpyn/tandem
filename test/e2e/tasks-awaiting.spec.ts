// The company-wide awaiting-decision queue (#91): a submit-for-review with an
// explicit human reviewer spawns a PENDING approval obligation on THEM — the
// "Awaiting decision" chip must surface the task for a session that owes
// nothing itself (inbox ≠ company), rows badge the review as pending, and the
// overview card carries the live count.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test('awaiting-decision queue: company-wide filter, row badge, deep link, overview card', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const humanName = `E2e Human ${suffix}`;
  const taskTitle = `AW ${suffix}`;

  // a second human to owe the review
  await tasks.navigate('/employees');
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(humanName);
  await page.getByPlaceholder('name@company.com').fill(`e2e-human-${suffix}@tandem.local`);
  const humanRadio = page.getByRole('radio', { name: /Human/ });
  if (await humanRadio.isVisible().catch(() => false)) await humanRadio.check();
  await page.getByPlaceholder('Job title').fill('Reviewer');
  await page.getByRole('button', { name: /Save|Create employee/ }).click();
  await expect(page.locator('tr:visible', { hasText: humanName })).toBeVisible({ timeout: 15_000 });

  // task assigned to me, reviewed by THEM → submit spawns THEIR obligation
  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: 'Admin' });
  await page.getByText('Add reviewers…').click();
  await page.getByRole('option', { name: humanName }).first().click();
  await page.keyboard.press('Escape');
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });

  // doing → submit for review: the round opens on the reviewer's obligation
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Doing' }).click();
  await expect(tasks.rowFor(taskTitle)).toContainText('Doing', { timeout: 10_000 });
  const drawer = await tasks.openWorkflowDrawer(row);
  await drawer.getByRole('button', { name: 'Submit for review' }).click();
  await page.keyboard.press('Escape');
  await expect(tasks.rowFor(taskTitle)).toContainText('Review pending', { timeout: 15_000 });

  // the chip filters server-side; the obligation is NOT on me — the inbox badge
  // must stay hidden while the company queue still lists the task
  await page.getByTestId('awaiting-decision-toggle').click();
  await expect(page.getByTestId('awaiting-decision-toggle')).toHaveAttribute('aria-pressed', 'true');
  // URL sync rides a post-toggle watcher tick — poll, never assert once (flaked
  // the v2.60.0 release train 2026-10-31: both CI attempts lost the race)
  await expect.poll(() => page.url()).toContain('awaiting=1');
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('inbox-count')).toHaveCount(0);

  // deep link restores the filter on a fresh load
  await tasks.navigate('/tasks?awaiting=1');
  await expect(page.getByTestId('awaiting-decision-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  // toggling off drops the query param
  await page.getByTestId('awaiting-decision-toggle').click();
  await expect(page).toHaveURL((u) => !u.search.includes('awaiting'));
  await expect(tasks.rowFor(taskTitle)).toBeVisible({ timeout: 15_000 });

  // overview card: live count (a number, not the em-dash placeholder) linking
  // to the pre-filtered list
  await tasks.navigate('/');
  const card = page.getByRole('link', { name: /Waiting on a decision from anyone/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText(/\d/, { timeout: 15_000 });
});
