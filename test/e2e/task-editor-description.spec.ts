// E2E: TaskEditorModal description prefetch (#145).
// The modal back-fills the body from the on-demand tasks.getDescription fetch.
// Pins the NO-SILENT-WIPE GUARD (SPEC.md SNAPSHOT-SLIMMING LAW): a save while
// that fetch is failed — the pre-#143-impossible shape — must OMIT the
// description from the update patch instead of wiping the stored body with ''.
import { expect, test } from './helpers/cleanup';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

/** create a task with a description body through the New task modal */
async function createTaskWithBody(page: import('@playwright/test').Page, title: string, body: string) {
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.locator('.ProseMirror').fill(body);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });
}

test('edit modal prefills the stored description; an unedited save keeps it', async ({ page }) => {
  const tasks = new TasksPage(page);
  const title = `Prefill probe ${Date.now().toString(36)}`;
  const body = 'Guard the stored instructions body. Prefill probe.';
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await createTaskWithBody(page, title, body);

  // open the editor: the on-demand fetch prefills the body
  await page.getByRole('button', { name: `Edit ${title}` }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(page.locator('.ProseMirror')).toContainText(body, { timeout: 10_000 });

  // unedited save must not change the stored body
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeHidden();

  // reopen: the body survived the unedited save
  await page.getByRole('button', { name: `Edit ${title}` }).click();
  await expect(page.locator('.ProseMirror')).toContainText(body, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await tasks.deleteTask(title);
});

test('a failed description prefetch never wipes the stored body on save', async ({ page }) => {
  const tasks = new TasksPage(page);
  const title = `No-wipe probe ${Date.now().toString(36)}`;
  const body = 'This body must survive a failed prefetch. No-wipe probe.';
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await createTaskWithBody(page, title, body);

  // block the on-demand fetch BEFORE the editor opens
  await page.route('**/rpc/tasks/getDescription*', (route) => route.abort());

  await page.getByRole('button', { name: `Edit ${title}` }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  // the modal says the fetch failed and what a save will do
  await expect(page.getByText("Couldn't load the saved description")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.ProseMirror')).not.toContainText(body);

  // unedited save while the body is unknown: the stored body must survive
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeHidden();

  // fetch unblocked: the body is still there
  await page.unroute('**/rpc/tasks/getDescription*');
  await page.getByRole('button', { name: `Edit ${title}` }).click();
  await expect(page.locator('.ProseMirror')).toContainText(body, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await tasks.deleteTask(title);
});
