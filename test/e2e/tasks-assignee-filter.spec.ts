// ASSIGNEE SCOPE LAW (#353): the tasks list/board filters by assignee —
// `?assignee=<userId>` is URL-backed (share/reload restores it), "My tasks" is
// the session's own id, the filter composes with the other list filters, and a
// task detail opened from the filtered list returns to the same filtered list.
//
// The roster is seeded directly (SQL-seed law: explicit id + timestamps), the
// tasks are created through the real UI so the editor path stays covered, and
// the cleanup fixture sweeps every row this test created.
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { TasksPage } from './pages/tasks.page.ts';

async function seedEmployee(name: string, email: string): Promise<string> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const id = crypto.randomUUID();
  try {
    await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at, role, title, must_change_password)
      values (${id}, ${name}, ${email}, false, now(), now(), 'EMPLOYEE', 'Teammate', false)`;
  } finally {
    await sql.close();
  }
  return id;
}

test('assignee scope: filter, My tasks, deep link and back-link round-trip', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const mateName = `E2E Mate ${suffix}`;
  const mateId = await seedEmployee(mateName, `e2e-mate-${suffix}@tandem.local`);
  const mineTitle = `AM mine ${suffix}`;
  const mateTitle = `AM mate ${suffix}`;

  // one task assigned to the boot admin (Me), one to the seeded teammate
  await tasks.navigate('/tasks');
  await tasks.createTask({ title: mineTitle, assignee: 'Admin' });
  await expect(tasks.rowFor(mineTitle)).toBeVisible({ timeout: 15_000 });
  await tasks.createTask({ title: mateTitle, assignee: mateName });
  await expect(tasks.rowFor(mateTitle)).toBeVisible({ timeout: 15_000 });

  // the assignee select filters the list down to one employee's tasks
  const select = page.getByRole('combobox', { name: 'Filter by assignee' });
  await select.click();
  await page.getByRole('option', { name: mateName, exact: true }).click();
  await expect(tasks.rowFor(mateTitle)).toBeVisible();
  await expect(page.locator('tr:visible').filter({ hasText: mineTitle })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('assignee')).toBe(mateId);

  // the URL is the source of truth: a reload restores the scope and its label
  await page.reload();
  await expect(select).toContainText(mateName);
  await expect(tasks.rowFor(mateTitle)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('tr:visible').filter({ hasText: mineTitle })).toHaveCount(0);

  // "My tasks" is the session's own id — the admin's task only
  await select.click();
  await page.getByRole('option', { name: 'My tasks', exact: true }).click();
  await expect(tasks.rowFor(mineTitle)).toBeVisible();
  await expect(page.locator('tr:visible').filter({ hasText: mateTitle })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('assignee')).not.toBe(mateId);

  // a task opened from the scoped list carries the scope on its detail URL and
  // the detail page's back link rebuilds the same filtered list
  await page.getByRole('link', { name: mineTitle }).first().click();
  await expect(page).toHaveURL(new RegExp('/tasks/[0-9a-f-]+\\?.*assignee='));
  await page.getByRole('link', { name: 'Back to tasks' }).first().click();
  await expect(page).toHaveURL(/\/tasks\?.*assignee=/);
  await expect(tasks.rowFor(mineTitle)).toBeVisible();
  await expect(page.locator('tr:visible').filter({ hasText: mateTitle })).toHaveCount(0);

  // "Anyone" clears the scope and the URL param
  await select.click();
  await page.getByRole('option', { name: 'Anyone', exact: true }).click();
  await expect(tasks.rowFor(mateTitle)).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('assignee')).toBeNull();
});
