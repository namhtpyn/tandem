// #96: the workflow drawer must be reachable from a MOBILE card. At 390×844
// the list renders cards whose only action surface is the kebab menu, so the
// kebab carries a Workflow item opening the same drawer as the desktop row
// button (MOBILE-FIRST law: every surface usable at phone widths, ≥44px taps).
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test.use({ viewport: { width: 390, height: 844 } });

test('workflow drawer opens from a mobile list card kebab', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  await tasks.navigate('/tasks');
  await tasks.createTask({ title: `MWF ${suffix}` });

  const kebab = page.getByRole('button', { name: `Actions for MWF ${suffix}` });
  await expect(kebab).toBeVisible({ timeout: 15_000 });
  await kebab.click();

  // the drawer entry is a real phone tap target (≥44px, MOBILE-FIRST law)
  const workflowItem = page.getByRole('button', { name: 'Workflow', exact: true });
  await expect(workflowItem).toBeVisible();
  await expect(workflowItem).toHaveCSS('min-height', '44px');
  await workflowItem.click();

  const drawer = page.getByRole('dialog', { name: 'Task workflow' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/no activity yet/i)).toBeVisible();
});

test('workflow drawer opens from a mobile board card kebab too', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  await tasks.navigate('/tasks');
  // create in list view — the board toolbar hides New task while the board is
  // empty, and the List/Board toggle itself is not reliably clickable at
  // 390×844 (separate audit finding); neither is what this test is about
  await tasks.createTask({ title: `MWB ${suffix}` });

  // flip to board view the way a returning user arrives: persisted preference
  // (vueuse's string serializer stores RAW values — no JSON quotes)
  await page.evaluate(() => localStorage.setItem('tasks:view', 'board'));
  await page.reload();

  const kebab = page.getByRole('button', { name: `Actions for MWB ${suffix}` });
  await expect(kebab).toBeVisible({ timeout: 15_000 });
  await kebab.click();

  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Task workflow' })).toBeVisible();
});
