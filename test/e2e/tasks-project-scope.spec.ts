// TASK SCOPE LAW (#339): a project row drills into its own tasks — one click to
// /tasks?project=<id>, the filter is URL-synced (reload/share restore it), the
// project select names the scope and can set it too, clearing it widens back to
// every task, and the list empty state always names the scoped project.
import { expect, test } from './helpers/cleanup';
import { waitForHydration } from './helpers/login';
import { TasksPage } from './pages/tasks.page.ts';

/** oRPC write as the signed-in admin (envelope: {json: input}) */
async function rpc(page: import('@playwright/test').Page, path: string, input: unknown) {
  const res = await page.request.post(path, { data: { json: input } });
  const body = (await res.json().catch(() => ({}))) as { json?: { id?: string } };
  expect(res.status()).toBe(200);
  return body.json ?? {};
}

test('project scope: project row opens its tasks, select sets/clears, URL-synced', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const project = `Scope ${suffix}`;
  const inTitle = `IN ${suffix}`;
  const outTitle = `OUT ${suffix}`;

  const projectRow = await rpc(page, '/rpc/projects/create', { name: project });
  const projectId = projectRow.id;
  expect(projectId).toBeTruthy();
  await rpc(page, '/rpc/tasks/create', { title: inTitle, projectId });
  await rpc(page, '/rpc/tasks/create', { title: outTitle });

  // the project row carries the one-click drill-down
  await tasks.navigate('/projects');
  const row = page.locator('tr:visible', { hasText: project }).first();
  await row.getByTestId('project-view-tasks').click();
  await expect.poll(() => page.url()).toContain(`project=${projectId}`);
  await expect(page.getByTestId('project-scope-select')).toContainText(project);

  // only the project's task is listed
  await expect(tasks.rowFor(inTitle)).toBeVisible({ timeout: 15_000 });
  await expect(tasks.rowFor(outTitle)).toHaveCount(0);

  // URL state survives a reload (shareable scope)
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByTestId('project-scope-select')).toContainText(project);
  await expect(tasks.rowFor(inTitle)).toBeVisible({ timeout: 15_000 });
  await expect(tasks.rowFor(outTitle)).toHaveCount(0);

  // clearing the scope widens back to every task and drops the query param
  await page.getByTestId('project-scope-select').click();
  await page.getByRole('option', { name: 'All projects' }).click();
  await expect.poll(() => page.url()).not.toContain('project=');
  await expect(tasks.rowFor(outTitle)).toBeVisible({ timeout: 15_000 });
  await expect(tasks.rowFor(inTitle)).toBeVisible({ timeout: 15_000 });

  // the select's SET path scopes too (not just the project-row link)
  await page.getByTestId('project-scope-select').click();
  await page.getByRole('option', { name: project }).click();
  await expect.poll(() => page.url()).toContain(`project=${projectId}`);
  await expect(tasks.rowFor(inTitle)).toBeVisible({ timeout: 15_000 });
  await expect(tasks.rowFor(outTitle)).toHaveCount(0);

  // composed with a status chip: the empty copy keeps naming the project
  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(page.getByText(`No tasks in ${project} with this status`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
});

test('project scope: unresolvable scope degrades honestly (unknown id, sentinel)', async ({ page }) => {
  const tasks = new TasksPage(page);
  // a project must exist for the select to render at all (no-projects surfaces
  // hide it) — created so the unresolvable-id cases are not vacuous
  await rpc(page, '/rpc/projects/create', { name: `Probe ${Date.now().toString(36).slice(-6)}` });

  // an id no project owns: filter, never an error — the label says Unknown project
  await tasks.navigate('/tasks?project=00000000-0000-7000-8000-000000000000');
  await expect(page.getByTestId('project-scope-select')).toContainText('Unknown project');
  await expect(page.getByText('No tasks in this project', { exact: false })).toBeVisible({ timeout: 15_000 });

  // the internal NONE_ID sentinel is a display value, never a scope
  await tasks.navigate('/tasks?project=__none__');
  await expect(page.getByTestId('project-scope-select')).toContainText('All projects');
  await expect(page.getByTestId('project-scope-hint')).toHaveCount(0);
});

test('project scope: an empty project names itself in the empty state', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const project = `Empty ${suffix}`;
  const created = await rpc(page, '/rpc/projects/create', { name: project });
  await tasks.navigate(`/tasks?project=${created.id}`);
  await expect(page.getByText(`No tasks in ${project}`, { exact: false })).toBeVisible({ timeout: 15_000 });
});
