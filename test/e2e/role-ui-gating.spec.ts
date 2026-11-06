import { expect, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { SQL } from 'bun';

import { test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { waitForHydration } from './helpers/login';

// SPEC "Roles & access — UI tier visibility" (#263): the UI renders no verb
// above the viewer's tier. The nav filters admin-surface items to ADMIN, the
// Settings page renders its cards to ADMIN only, and the admin managers
// (Employees, Environments, Vault secrets + folders, Statuses) render
// read-only for non-admin deep links. UX only — the server tier matrix stays
// the boundary (already pinned server-side by the unit suites).
//
// Sign-in flow laws honored here: fresh contexts pass an EMPTY storageState
// (a default context inherits the admin's session), the form is filled only
// after the hydration gate, and the login submit reloads once before the
// dashboard shell mounts.

const EMPLOYEE_PASSWORD = 'e2e-employee-ui-pw';

async function rpcPost(page: Page, path: string, input: unknown) {
  const res = await page.request.post(path, { data: { json: input } });
  let json: { json?: unknown } = {};
  try {
    json = (await res.json()) as { json?: unknown };
  } catch {
    /* error statuses may carry no json envelope */
  }
  return { status: res.status(), json: json.json as { id?: string } | undefined };
}

/** human employee + a password credential row, so the UI form can sign in */
async function seedEmployeeWithPassword(page: Page, tag: string) {
  const email = `e2e-emp-${tag}@tandem.local`;
  const created = await rpcPost(page, '/rpc/employees/create', {
    name: `E2E Emp ${tag}`,
    email,
    kind: 'human',
    title: 'Tester',
  });
  expect(created.status).toBe(200);
  const userId = created.json?.id;
  expect(userId).toBeTruthy();

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    // SQL-seed law: explicit id + timestamps on every table (drizzle $default
    // is app-side; a raw insert without them dies on the not-null columns).
    // Mirror the boot seed's credential shape: account_id = the USER's id.
    await sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashPassword(EMPLOYEE_PASSWORD)}, now(), now())`;
  } finally {
    await sql.close();
  }
  return { email };
}

/** a VIEWER user + credential row — sign-up defaults to VIEWER, so this is the
 *  shape any fresh self-serve account gets; seeded directly to skip the flow */
async function seedViewerWithPassword(tag: string) {
  const email = `e2e-viewer-${tag}@tandem.local`;
  const userId = crypto.randomUUID();
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    // SQL-seed law: explicit id + timestamps + every $default column on both tables
    await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at, role, title, must_change_password)
      values (${userId}, ${`E2E Viewer ${tag}`}, ${email}, false, now(), now(), 'VIEWER', '', false)`;
    await sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
      values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashPassword(EMPLOYEE_PASSWORD)}, now(), now())`;
  } finally {
    await sql.close();
  }
  return { email };
}

/** an AI-assigned ready task: the Dispatch verb's gate (ready + AI assignee +
 *  no live run) is TRUE for employee-tier sessions, so a viewer-side count(0)
 *  on it is a REAL pin, not a state-vacuous one. Born-ineligible law (#297):
 *  park dispatch_before BEFORE attaching the assignee so the 5s scan can never
 *  claim the task mid-test (the manual dispatch verb ignores the hold). */
async function seedAiAssignedTask(page: Page, tag: string) {
  const env = await rpcPost(page, '/rpc/environments/create', {
    name: `E2E Env ${tag}`,
    host: '127.0.0.1',
    port: '22',
    username: 'e2e',
  });
  expect(env.status).toBe(200);
  const emp = await rpcPost(page, '/rpc/employees/create', {
    name: `E2E Bot ${tag}`,
    email: `e2e-bot-${tag}@tandem.local`,
    kind: 'ai',
    title: 'Runner',
    environmentId: env.json?.id,
    executable: 'hermes acp',
  });
  expect(emp.status).toBe(200);
  const employeeId = emp.json?.id;
  expect(employeeId).toBeTruthy();

  const created = await rpcPost(page, '/rpc/tasks/create', { title: `E2E View ${tag}` });
  expect(created.status).toBe(200);
  const taskId = created.json?.id;
  expect(taskId).toBeTruthy();

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId}`;
  } finally {
    await sql.close();
  }
  const attached = await rpcPost(page, '/rpc/tasks/update', { id: taskId, assigneeId: employeeId });
  expect(attached.status).toBe(200);
  return { taskId };
}

/** sign a FRESH browser context in through the real form (no storageState) */
async function signInAs(browser: import('@playwright/test').Browser, email: string) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/');
  await waitForHydration(page);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByLabel('Password').fill(EMPLOYEE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  // the login submit reloads; the dashboard shell is the success signal
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

test.describe('role UI gating (#263)', () => {
  test('employee tier: nav filters admin surfaces; deep links render read-only; statuses toolbar hides', async ({
    page,
    browser,
  }) => {
    const tag = Date.now().toString(36);
    const { email } = await seedEmployeeWithPassword(page, tag);
    const { context: empContext, page: emp } = await signInAs(browser, email);
    test.info().annotations.push({ type: 'note', description: `employee ${email}` });

    try {
      // ---- nav: admin-surface items gone, session-tier items stay ----
      for (const label of ['Vault', 'MCP', 'Environments', 'Employees', 'Settings']) {
        await expect(emp.getByRole('link', { name: label, exact: true })).toHaveCount(0);
      }
      for (const label of ['Overview', 'Tasks', 'Projects']) {
        await expect(emp.getByRole('link', { name: label, exact: true })).toHaveCount(1);
      }

      // ---- /settings: cards gone, read-only note ----
      await emp.goto('/settings');
      await expect(emp.getByText('Admin only')).toBeVisible();
      await expect(emp.getByRole('heading', { name: 'General' })).toHaveCount(0);
      await expect(emp.getByRole('heading', { name: 'Model providers' })).toHaveCount(0);

      // ---- /vault: no admin verbs render (vault reads are admin-tier, so the
      // list itself errors — the gate is what keeps every verb hidden) ----
      await emp.goto('/vault');
      await expect(emp.getByRole('button', { name: 'New secret' })).toHaveCount(0);
      await expect(emp.getByRole('button', { name: 'Folders' })).toHaveCount(0);
      // the folder filter would render dead above the error state (its own
      // read is admin-tier FORBIDDEN) — the editable gate hides it too
      await expect(emp.getByLabel('Filter by folder')).toHaveCount(0);

      // ---- /environments: read-only browser ----
      await emp.goto('/environments');
      await expect(emp.getByRole('button', { name: 'New environment' })).toHaveCount(0);

      // ---- /employees: no create/titles/keys verbs ----
      await emp.goto('/employees');
      await expect(emp.getByRole('button', { name: 'New employee' })).toHaveCount(0);
      await expect(emp.getByRole('button', { name: 'Titles' })).toHaveCount(0);
      await expect(emp.getByRole('button', { name: 'Access keys for E2E Emp' }).first()).toHaveCount(0);

      // ---- #300 regression: employee-tier verbs STAY for an employee ----
      // (a row task + a project seeded so the row verbs and CTAs render)
      const seeded = await rpcPost(page, '/rpc/tasks/create', { title: `E2E Row ${tag}` });
      expect(seeded.status).toBe(200);
      const seededProject = await rpcPost(page, '/rpc/projects/create', { name: `E2E Proj ${tag}` });
      expect(seededProject.status).toBe(200);
      await emp.goto('/tasks');
      await expect(emp.getByRole('button', { name: 'New task' }).first()).toBeVisible();
      await expect(emp.getByRole('button', { name: `Edit E2E Row ${tag}` })).toBeVisible();
      await expect(emp.getByRole('button', { name: `Auto-assign E2E Row ${tag}` })).toBeVisible();
      await emp.goto('/projects');
      await expect(emp.getByRole('button', { name: 'New project' }).first()).toBeVisible();
      await expect(emp.getByRole('button', { name: `Edit E2E Proj ${tag}` })).toBeVisible();

      // ---- #300 positive pin: the SAME verbs render for an employee ----
      // (the viewer test seeds the same AI-assigned shape and asserts each
      // gone; this side proves the gate hides nothing from EMPLOYEE)
      const { taskId: empTaskId } = await seedAiAssignedTask(page, tag);
      await emp.goto('/tasks');
      await emp
        .getByRole('button', { name: /^Workflow for / })
        .first()
        .click();
      await expect(emp.getByText('Task workflow').first()).toBeVisible();
      await expect(emp.getByTestId('drawer-verb-dispatch')).toBeVisible();
      await emp.goto(`/tasks/${empTaskId}`);
      await expect(emp.getByTestId('task-workflow-actions')).toBeVisible();
      await expect(emp.getByLabel('Task note')).toBeVisible();
      await expect(emp.getByRole('combobox', { name: 'Task status' }).first()).toBeVisible();
      await expect(emp.getByRole('button', { name: 'Add subtask' }).first()).toBeVisible();
      await emp.goto('/tasks');

      // ---- statuses manager: list renders, toolbar verbs gone ----
      await emp.goto('/tasks');
      await emp.getByRole('button', { name: 'Statuses', exact: true }).click();
      await expect(emp.getByText('Task statuses')).toBeVisible();
      await expect(emp.getByRole('button', { name: 'New status' })).toHaveCount(0);
      // the per-row edit verb rides the same editable gate ('Edit To do' is the
      // popover's aria-label; 'Delete To do' would be vacuous — builtin rows
      // carry a "built in and can't be deleted" label for EVERY role)
      await expect(emp.getByRole('button', { name: 'Edit To do' })).toHaveCount(0);
      // the list itself (session tier read) still renders
      await expect(emp.getByText('To do').first()).toBeVisible();
    } finally {
      await empContext.close();
    }
  });

  test('viewer tier (#300): tasks/projects render read-only — no verb above the employee tier', async ({
    page,
    browser,
  }) => {
    const tag = Date.now().toString(36);
    // rows for the viewer to READ (kebabs + status cells must exist to prove
    // their verbs are gone rather than vacuously absent). The task carries an
    // AI assignee so the drawer/detail Dispatch verb would render for an
    // employee-tier session — the viewer-side count(0) below is a real pin.
    const { taskId } = await seedAiAssignedTask(page, tag);
    const seededProject = await rpcPost(page, '/rpc/projects/create', { name: `E2E ViewProj ${tag}` });
    expect(seededProject.status).toBe(200);

    const { email } = await seedViewerWithPassword(tag);
    const { context: viewerContext, page: viewer } = await signInAs(browser, email);
    test.info().annotations.push({ type: 'note', description: `viewer ${email}` });

    try {
      // ---- /tasks list: create CTAs + row verbs gone, list itself stays ----
      await viewer.goto('/tasks');
      await expect(viewer.getByRole('button', { name: 'New task' })).toHaveCount(0);
      await expect(viewer.getByText(`E2E View ${tag}`).first()).toBeVisible();
      await expect(viewer.getByRole('button', { name: `Auto-assign E2E View ${tag}` })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: `Edit E2E View ${tag}` })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: `Delete E2E View ${tag}` })).toHaveCount(0);
      // the status cell is the setStatus verb — a viewer gets plain text
      await expect(viewer.getByRole('combobox', { name: /^Status for/ })).toHaveCount(0);
      // …and the assignee cell is the tasks.update verb (#333) — never a control
      await expect(viewer.getByRole('combobox', { name: /^Assignee for/ })).toHaveCount(0);
      await expect(viewer.getByText('To do').first()).toBeVisible();
      // the kebab survives with its READ entry (Workflow) — the drawer opens
      await expect(viewer.getByRole('button', { name: /^Workflow for / }).first()).toBeVisible();

      // ---- board view: drag/move-to are setStatus writes, kebab reduced ----
      // localStorage law: useLocalStorage reads RAW values, not JSON
      await viewer.goto('/tasks');
      await viewer.evaluate(() => localStorage.setItem('tasks:view', 'board'));
      await viewer.reload();
      await waitForHydration(viewer);
      const kebab = viewer.getByRole('button', { name: `Actions for E2E View ${tag}` }).first();
      await expect(kebab).toBeVisible();
      await kebab.click();
      await expect(viewer.getByText('Workflow', { exact: true }).first()).toBeVisible();
      await expect(viewer.getByText('Move to…')).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Auto-assign', exact: true })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
      // the drag path is the same setStatus write — off for a viewer
      await expect(viewer.locator('article[draggable="false"]').first()).toBeVisible();

      // ---- task drawer: no workflow verbs, no composer, no review box ----
      // (Dispatch now is a REAL pin here: the seeded task is ready + AI-assigned)
      // back to list view — the Workflow-for trigger is a list-row affordance
      await viewer.evaluate(() => localStorage.setItem('tasks:view', 'list'));
      await viewer.goto('/tasks');
      await viewer
        .getByRole('button', { name: /^Workflow for / })
        .first()
        .click();
      await expect(viewer.getByText('Task workflow').first()).toBeVisible();
      await expect(viewer.getByTestId('drawer-verb-dispatch')).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Submit for review' })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Forward' })).toHaveCount(0);
      await expect(viewer.getByLabel('Task note')).toHaveCount(0);
      await expect(viewer.getByTestId('drawer-composer-hint')).toHaveCount(0);
      // the read surface stays: runs + activity still render
      await expect(viewer.getByText('Agent runs').first()).toBeVisible();

      // ---- task detail page: composer, workflow verbs, Details selects and
      //      add-subtask all hide below the tier; the thread read stays ----
      await viewer.goto(`/tasks/${taskId}`);
      await expect(viewer.getByTestId('task-workflow-actions')).toHaveCount(0);
      await expect(viewer.getByLabel('Task note')).toHaveCount(0);
      await expect(viewer.getByRole('combobox', { name: 'Task status' })).toHaveCount(0);
      await expect(viewer.getByRole('combobox', { name: 'Task assignee' })).toHaveCount(0);
      await expect(viewer.getByRole('combobox', { name: 'Task project' })).toHaveCount(0);
      await expect(viewer.getByTestId('detail-status-plain').first()).toBeVisible();
      await expect(viewer.getByRole('button', { name: 'Add subtask' })).toHaveCount(0);
      await expect(viewer.getByText(`E2E View ${tag}`).first()).toBeVisible();

      // ---- /projects: tree reads, create/edit/delete verbs gone ----
      await viewer.goto('/projects');
      await expect(viewer.getByRole('button', { name: 'New project' })).toHaveCount(0);
      await expect(viewer.getByText(`E2E ViewProj ${tag}`).first()).toBeVisible();
      await expect(viewer.getByRole('button', { name: `Add subproject under E2E ViewProj ${tag}` })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: `Edit E2E ViewProj ${tag}` })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: `Delete E2E ViewProj ${tag}` })).toHaveCount(0);
      // TASK SCOPE LAW (#339): reading a project's tasks is session-tier, so the
      // drill-down renders for a viewer while the write trio above stays gone
      await expect(
        viewer.locator('tr:visible', { hasText: `E2E ViewProj ${tag}` }).getByTestId('project-view-tasks'),
      ).toBeVisible();

      // ---- statuses manager: opens (session-tier read), verbs stay gated ----
      // LAST — the open modal owns the screen and this test has no teardown
      await viewer.goto('/tasks');
      await viewer.getByRole('button', { name: 'Statuses', exact: true }).click();
      await expect(viewer.getByText('Task statuses')).toBeVisible();
      await expect(viewer.getByRole('button', { name: 'New status' })).toHaveCount(0);
      await expect(viewer.getByRole('button', { name: 'Edit To do' })).toHaveCount(0);
    } finally {
      await viewerContext.close();
    }
  });

  test('admins see no change: every nav item renders and settings cards stay', async ({ page }) => {
    // the page fixture starts at about:blank — navigate explicitly
    await page.goto('/');
    for (const label of ['Overview', 'Vault', 'MCP', 'Environments', 'Employees', 'Tasks', 'Projects', 'Settings']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(1);
    }
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByText('Admin only')).toHaveCount(0);
  });
});
