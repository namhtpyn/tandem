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

      // ---- /environments: read-only browser ----
      await emp.goto('/environments');
      await expect(emp.getByRole('button', { name: 'New environment' })).toHaveCount(0);

      // ---- /employees: no create/titles/keys verbs ----
      await emp.goto('/employees');
      await expect(emp.getByRole('button', { name: 'New employee' })).toHaveCount(0);
      await expect(emp.getByRole('button', { name: 'Titles' })).toHaveCount(0);
      await expect(emp.getByRole('button', { name: 'Access keys for E2E Emp' }).first()).toHaveCount(0);

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
