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

  // composed with the obligation toggles: their empty copy stays scoped to the
  // project (a bare company-wide sentence would be false inside a scope)
  await page.getByRole('button', { name: 'Needs my decision' }).click();
  await expect(page.getByText(`Nothing in ${project} matches your decision filter right now.`)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Needs my decision' }).click();
  await page.getByRole('button', { name: 'Awaiting decision' }).click();
  await expect(page.getByText(`Nothing in ${project} matches your awaiting-decision filter right now.`)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Awaiting decision' }).click();

  // composed with a status chip: the empty copy keeps naming the project
  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect(page.getByText(`No tasks in ${project} with this status`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  // an obligation toggle composes with the chip too — copy names both
  await page.getByRole('button', { name: 'Needs my decision' }).click();
  await expect(
    page.getByText(`Nothing in ${project} matches your decision filter with this status right now.`),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Needs my decision' }).click();
  // …and a search term reads as a search miss, not as 'the project is empty'
  await page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('zzz-no-match');
  await expect(page.getByText(`No tasks in ${project} match this search.`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
});

test('project scope: unresolvable scope degrades honestly (unknown id, sentinel)', async ({ page }) => {
  const tasks = new TasksPage(page);
  // a project must exist for the select to render at all (no-projects surfaces
  // hide it) — created so the unresolvable-id cases are not vacuous
  const probe = `Probe ${Date.now().toString(36).slice(-6)}`;
  const created = await rpc(page, '/rpc/projects/create', { name: probe });

  // an id no project owns: filter, never an error — the label says Unknown project,
  // and the scoped-looking empty CTA hides (a create there cannot land in scope;
  // the toolbar entry stays, and never sends the dead id)
  await tasks.navigate('/tasks?project=00000000-0000-7000-8000-000000000000');
  await expect(page.getByTestId('project-scope-select')).toContainText('Unknown project');
  await expect(page.getByText('No tasks in this project', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('empty-new-task')).toHaveCount(0);

  // the internal NONE_ID sentinel is a display value, never a scope — and the
  // dead param is stripped from the URL on mount (no scope claim in the address)
  await tasks.navigate('/tasks?project=__none__');
  await expect(page.getByTestId('project-scope-select')).toContainText('All projects');
  await expect(page.getByTestId('project-scope-hint')).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain('project=');

  // multi-valued param: the URL normalizes to the ONE real scope (sentinel first
  // must not swallow the valid second value)
  await tasks.navigate(`/tasks?project=__none__&project=${created.id}`);
  await expect(page.getByTestId('project-scope-select')).toContainText(probe);
  await expect.poll(() => page.url()).not.toContain('__none__');
});

test('project scope: the mobile project card carries the drill-down', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const project = `Mobile ${suffix}`;
  const inTitle = `MIN ${suffix}`;
  const created = await rpc(page, '/rpc/projects/create', { name: project });
  await rpc(page, '/rpc/tasks/create', { title: inTitle, projectId: created.id });

  // phone width: DataTable swaps the table for mobile cards — the drill-down must
  // ride the card too (SPEC: desktop actions + mobile card)
  await page.setViewportSize({ width: 390, height: 844 });
  await tasks.navigate('/projects');
  const drill = page.locator(`[aria-label="View tasks in ${project}"]:visible`);
  await expect(drill).toBeVisible({ timeout: 15_000 });
  await drill.click();
  await expect.poll(() => page.url()).toContain(`project=${created.id}`);
  await expect(page.getByTestId('project-scope-select')).toContainText(project);
  // mobile cards render the row anchor; the hidden desktop row is the first match
  await expect(page.locator('a:visible').filter({ hasText: inTitle }).first()).toBeVisible({ timeout: 15_000 });
});

test('project scope: an empty project names itself and creates inside the scope', async ({ page }) => {
  const tasks = new TasksPage(page);
  const suffix = Date.now().toString(36).slice(-6);
  const project = `Empty ${suffix}`;
  const title = `NEW ${suffix}`;
  const created = await rpc(page, '/rpc/projects/create', { name: project });
  await tasks.navigate(`/tasks?project=${created.id}`);
  await expect(page.getByText(`No tasks in ${project} yet.`, { exact: false })).toBeVisible({ timeout: 15_000 });

  // creating from the scoped list inherits the scope — the new row appears here
  // (the editor's Project pre-fills from the active scope), no dead end. Uses the
  // EMPTY-STATE CTA (not the toolbar entry) so that affordance is pinned too.
  await page.getByTestId('empty-new-task').click();
  await expect(page.getByRole('dialog').getByText(project, { exact: true }).first()).toBeVisible();
  await tasks.fillTaskForm({ title });
  await tasks.saveTask();
  await expect(tasks.rowFor(title)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`No tasks in ${project}`, { exact: false })).toHaveCount(0);
});
