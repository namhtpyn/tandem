// Dispatch render-parity on the /tasks workflow drawer (#209, SPEC): the
// drawer's 'Dispatch now' obeys the SAME server-truth gate as the task page —
// AI assignee + ready category + no live run. It used to gate on assignee kind
// alone, rendering an ENABLED verb the server refuses in every non-ready state
// (worst case: 'Run in progress' streaming directly below it). Pinned here:
// absent on in-review/cancelled tasks, gone the moment a dispatch claims the
// task, and still gone after the run settles.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

async function seedAiEmployee(page: import('@playwright/test').Page, tag: string): Promise<string> {
  const env = await page.request.post('/rpc/environments/create', {
    data: { json: { name: `E2E Env ${tag}`, host: '127.0.0.1', port: '22', username: 'e2e' } },
  });
  expect(env.status()).toBe(200);
  const emp = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `E2E Bot ${tag}`,
        email: `e2e-drawer-dispatch-${tag}@tandem.local`,
        kind: 'ai',
        title: 'Runner',
        environmentId: ((await env.json()) as { json?: { id?: string } }).json?.id,
        executable: 'hermes acp',
      },
    },
  });
  expect(emp.status()).toBe(200);
  return `E2E Bot ${tag}`;
}

test('drawer dispatch: ready AI task fires in one click; the verb dies with the claim', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `DDRD ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: botName });
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });

  const drawer = await tasks.openWorkflowDrawer(row);
  const dispatch = drawer.getByTestId('drawer-verb-dispatch');
  await expect(dispatch).toBeVisible({ timeout: 10_000 });

  await dispatch.click();
  await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 10_000 });
  // the claim flipped the task out of ready — the verb unmounts with the state
  // (the kind-only gate kept it ENABLED under the streaming run card)
  await expect(dispatch).toHaveCount(0, { timeout: 15_000 });
  await expect(drawer.getByText("Couldn't dispatch")).toHaveCount(0);

  // the fake runner settles the run: the verb stays gone on a DONE task too —
  // the kind-only gate would have re-offered dispatch on the terminal state
  await expect(drawer.getByText(/Run completed/i)).toBeVisible({ timeout: 30_000 });
  await expect(dispatch).toHaveCount(0);
});

test('drawer dispatch: non-ready AI task renders no verb the server would refuse', async ({ page }) => {
  const tasks = new TasksPage(page);
  const tag = Date.now().toString(36).slice(-6);
  const botName = await seedAiEmployee(page, tag);
  const taskTitle = `DDNR ${tag}`;

  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title: taskTitle, assignee: botName });
  await tasks.saveTask();
  const row = tasks.rowFor(taskTitle);
  await expect(row).toBeVisible({ timeout: 15_000 });
  // let the create refetch wave settle before driving the row's status select —
  // a mid-settle click can submit a select value before statuses resolve
  await expect(row).toContainText(botName, { timeout: 10_000 });

  // in-review: same AI assignee, non-ready category — no verb
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'In review' }).click();
  await expect(row).toContainText('In review', { timeout: 10_000 });
  let drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByTestId('drawer-verb-dispatch')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  // cancelled: terminal category — still no verb
  await page.locator('tbody').getByLabel(`Status for ${taskTitle}`).click();
  await page.getByRole('option', { name: 'Cancelled' }).click();
  await expect(row).toContainText('Cancelled', { timeout: 10_000 });
  drawer = await tasks.openWorkflowDrawer(row);
  await expect(drawer.getByTestId('drawer-verb-dispatch')).toHaveCount(0);
});
