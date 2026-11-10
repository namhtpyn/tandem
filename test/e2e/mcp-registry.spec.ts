// E2E: MCP registry + per-agent bindings (SPEC "## MCP (registry + per-agent
// bindings)"). Covers: registry CRUD through /mcp, the in-use remove guard
// (400 while a binding exists, surfaced then unbind+delete succeeds), the
// binding-level probe verdict badges against a local JSON-RPC initialize
// server, fake-runner dispatch naming bound servers in the run output, and
// unbind = revoke on the next dispatch.
//
// The shared cleanup fixture sweeps users/tasks/environments/vault rows but
// NOT the mcp tables — the mcpSweep fixture below removes this file's
// bindings + servers BEFORE the shared sweep (they reference the employee
// user + vault secret that sweep deletes).
import { SQL } from 'bun';

import { expect, test as cleanupTest } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { waitForHydration } from './pages/base.page.ts';
import { McpPage } from './pages/mcp.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

const test = cleanupTest.extend<{ mcpSweep: void }>({
  // auto fixture, teardown-ordered BEFORE the shared dbCleanup sweep (fixtures
  // tear down LIFO): mcp_server_bindings join the employee user and the vault
  // secret — both swept — so the child rows must die first.
  mcpSweep: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures need a destructuring pattern
    async ({}, use) => {
      const startedAt = new Date();
      await use();
      const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
      const failures: string[] = [];
      try {
        for (const statement of [
          'delete from mcp_server_bindings where created_at >= $1',
          'delete from mcp_servers where created_at >= $1',
        ]) {
          try {
            await sql.unsafe(statement, [startedAt]);
          } catch (e) {
            failures.push(`${statement}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        await sql.close();
      }
      if (failures.length) throw new Error(`mcp cleanup failed:\n${failures.join('\n')}`);
    },
    { auto: true },
  ],
});
// ---- oRPC seeding: every write rides the browser session's cookies via
// page.request (oRPC v2 wraps payloads in { json }) --------------------------

async function rpcPost(page: import('@playwright/test').Page, path: string, input: unknown) {
  const res = await page.request.post(path, { data: { json: input } });
  let json: { json?: unknown } = {};
  try {
    json = (await res.json()) as { json?: unknown };
  } catch {
    /* error statuses may carry no json envelope */
  }
  return { status: res.status(), json: json.json as { id?: string } | undefined };
}

/** AI employee on a throwaway environment — the dispatch/probe subject */
async function seedAiEmployee(
  page: import('@playwright/test').Page,
  tag: string,
): Promise<{ employeeId: string; employeeName: string }> {
  const env = await rpcPost(page, '/rpc/environments/create', {
    name: `E2E MCP Env ${tag}`,
    host: '127.0.0.1',
    port: '22',
    username: 'e2e',
  });
  expect(env.status).toBe(200);
  const employeeName = `E2E MCP Bot ${tag}`;
  const emp = await rpcPost(page, '/rpc/employees/create', {
    name: employeeName,
    email: `e2e-mcp-${tag}@tandem.local`,
    kind: 'ai',
    title: 'Runner',
    environmentId: env.json?.id,
    executable: 'hermes acp',
  });
  expect(emp.status).toBe(200);
  return { employeeId: emp.json?.id as string, employeeName };
}

/** write the dispatch_after hold (15 min) on one task and prove the row matched.
 *  A silent 0-row UPDATE would let the 5s scan claim the task mid-test (#387);
 *  the future margin is proven by the separate read-back below. */
async function holdDispatchScan(taskId: string): Promise<void> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const held =
      await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId} returning id`;
    expect(held.length, 'dispatch_after hold landed on the task').toBe(1);
  } finally {
    await sql.close();
  }
}

/** read-back (fresh statement, real clock): the hold stands AND the seeded
 *  employee is the assignee. Both are seed preconditions — if either silently
 *  no-ops the #387 scan-claim window returns, so fail loudly at the seed. */
async function expectDispatchHold(taskId: string, employeeId: string): Promise<void> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      select (dispatch_after - now()) > interval '10 minutes' as held,
             assignee_id = ${employeeId} as attached
      from tasks where id = ${taskId}`;
    expect(rows.length, 'task row exists for the seed read-back').toBe(1);
    expect(rows[0]!.held, 'dispatch_after hold has a real future margin').toBe(true);
    expect(rows[0]!.attached, 'seeded employee is the assignee').toBe(true);
  } finally {
    await sql.close();
  }
}

/** BORN-INELIGIBLE SEEDING (#297, #387): a task created WITH the AI assignee is
 *  scanner-eligible at insert, so the 5s dispatch tick can claim it while the
 *  drawer settles — the dispatch verb unmounts mid-click and Playwright waits
 *  60s on a button that never returns. Create it unassigned, hold dispatch_after,
 *  then attach the assignee through the RPC edge: the scan AND the note path
 *  respect the hold; only the manual Dispatch-now verb ignores it, which is the
 *  verb these specs drive (the manual-bypass contract itself is pinned in
 *  task-drawer-dispatch.spec.ts, not here). (The hold's retry banner is inert
 *  seed state, never an assertion surface.) */
async function createTaskWithHeldScan(
  page: import('@playwright/test').Page,
  tasks: TasksPage,
  title: string,
  employeeId: string,
): Promise<ReturnType<TasksPage['rowFor']>> {
  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title });
  await tasks.saveTask();
  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const link = row.locator('a[href^="/tasks/"]').first();
  await expect(link).toHaveAttribute('href', /^\/tasks\/[0-9a-z-]+/i);
  const href = (await link.getAttribute('href')) as string;
  expect(href, 'task row links to the task page').toBeTruthy();
  // strip any list-scope query the row link carries (task-scope law), or the
  // SQL key below silently misses and the hold never lands
  const taskId = (href as string).split('?')[0]!.split('/').pop() as string;
  expect(taskId, 'task id from the row link').toBeTruthy();
  await holdDispatchScan(taskId);
  const attach = await rpcPost(page, '/rpc/tasks/update', { id: taskId, assigneeId: employeeId });
  expect(attach.status).toBe(200);
  // re-hold after the attach (the write that makes the task eligible) instead of
  // pinning "attach preserves the backoff": the read-back then proves the seed,
  // not an unspecced product invariant — same pattern as the status flip below
  await holdDispatchScan(taskId);
  await expectDispatchHold(taskId, employeeId);
  return row;
}

async function seedSecret(page: import('@playwright/test').Page, tag: string): Promise<string> {
  const res = await rpcPost(page, '/rpc/vault/secrets/create', {
    name: `MCP cred ${tag}`,
    description: '',
    value: `sk-e2e-mcp-${tag}`,
    folderId: null,
  });
  expect(res.status).toBe(200);
  return res.json?.id as string;
}

async function seedServer(page: import('@playwright/test').Page, name: string, url: string): Promise<string> {
  const res = await rpcPost(page, '/rpc/mcp/registryCreate', { name, url, notes: '' });
  expect(res.status).toBe(200);
  return res.json?.id as string;
}

async function bindServer(
  page: import('@playwright/test').Page,
  employeeId: string,
  serverId: string,
  secretId?: string,
): Promise<void> {
  const res = await rpcPost(page, '/rpc/mcp/bindingsSet', {
    employeeId,
    serverId,
    ...(secretId ? { secretId } : {}),
  });
  expect(res.status).toBe(200);
}

/** first seeded ready-category status id — the re-dispatch status flip target */
async function readyStatusId(): Promise<string> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`select id from task_statuses where category = 'ready' order by position asc limit 1`;
    return rows[0].id as string;
  } finally {
    await sql.end();
  }
}

/** open the agent editor's MCP bindings section for a seeded employee */
async function openMcpSection(page: import('@playwright/test').Page, employeeName: string) {
  await page.goto('/employees');
  await waitForHydration(page);
  await page.getByPlaceholder('Search employees…').fill(employeeName);
  const empRow = page.locator('tr:visible', { hasText: employeeName }).first();
  await expect(empRow).toBeVisible({ timeout: 15_000 });
  await empRow.getByRole('button', { name: /Edit / }).click();
  const editor = page.getByRole('dialog', { name: 'Edit employee' });
  await expect(editor).toBeVisible();
  const bindingRow = editor.getByTestId('mcp-binding-row');
  await expect(bindingRow).toBeVisible({ timeout: 15_000 });
  return { editor, bindingRow };
}

test.describe('mcp registry + bindings', () => {
  test('registry CRUD through the /mcp UI; admin nav item present', async ({ page }) => {
    const mcp = new McpPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const name = `E2E MCP ${tag}`;

    await mcp.open();
    // layout law: the MCP item sits right after Vault, admin-only
    await expect(page.getByRole('link', { name: 'MCP', exact: true })).toBeVisible();

    await mcp.createServer({ name, url: `http://127.0.0.1:9/${tag}`, notes: 'first notes' });
    await expect(mcp.rowFor(name)).toBeVisible({ timeout: 15_000 });

    // edit notes
    await mcp.rowFor(name).getByRole('button', { name: /Edit / }).click();
    await page.getByRole('textbox', { name: 'Notes' }).fill('updated notes');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(mcp.rowFor(name)).toContainText('updated notes', { timeout: 15_000 });

    // two-step delete
    await mcp
      .rowFor(name)
      .getByRole('button', { name: /Delete / })
      .click();
    await mcp.confirmDelete();
    await expect(mcp.rowFor(name)).toHaveCount(0, { timeout: 15_000 });
  });

  test('registry remove is guarded while a binding exists; unbind then delete succeeds', async ({ page }) => {
    const mcp = new McpPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId } = await seedAiEmployee(page, tag);
    const serverName = `E2E Guarded ${tag}`;
    const serverId = await seedServer(page, serverName, `http://127.0.0.1:9/${tag}`);
    const secretId = await seedSecret(page, tag);
    await bindServer(page, employeeId, serverId, secretId);

    await mcp.open();
    const row = mcp.rowFor(serverName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    // the binding shows in the count column
    await expect(row.getByTestId('mcp-binding-count')).toHaveText('1', { timeout: 15_000 });

    // remove → the server refuses (SPEC in-use guard, 400) and its message line
    // is surfaced in the confirm; the entry survives
    await row.getByRole('button', { name: /Delete / }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete server' });
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    await expect(mcp.rowFor(serverName)).toBeVisible();

    // unbind via the admin verb, retry the delete from the still-open confirm
    const unbind = await rpcPost(page, '/rpc/mcp/bindingsRemove', { employeeId, serverId });
    expect(unbind.status).toBe(200);
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(mcp.rowFor(serverName)).toHaveCount(0, { timeout: 15_000 });
  });

  test('probe verdict: initialize handshake flips the badge to OK; credential stays masked', async ({ page }) => {
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);

    // in-spec MCP server answering POST with a JSON-RPC initialize result
    const mcpServer = Bun.serve({
      port: 0, // ephemeral
      fetch: () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't', version: '1' } },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    const serverName = `E2E Probe ${tag}`;
    const serverId = await seedServer(page, serverName, `http://127.0.0.1:${mcpServer.port}/mcp`);
    const secretId = await seedSecret(page, tag);
    await bindServer(page, employeeId, serverId, secretId);

    try {
      const { editor, bindingRow } = await openMcpSection(page, employeeName);

      // never-probed verdict first
      await expect(bindingRow.getByTestId('mcp-probe-never')).toBeVisible();
      // write-only vault law: secret name + last-four hint, never the plaintext
      await expect(bindingRow).toContainText(`MCP cred ${tag}`);
      await expect(bindingRow).toContainText('••••');
      await expect(bindingRow).not.toContainText(`sk-e2e-mcp-${tag}`);

      // probe → the OK verdict persists on the binding row and renders
      await bindingRow.getByRole('button', { name: `Probe ${serverName}` }).click();
      await expect(bindingRow.getByTestId('mcp-probe-ok')).toBeVisible({ timeout: 15_000 });
      await editor.getByRole('button', { name: 'Cancel' }).click();
      await expect(editor).toBeHidden({ timeout: 10_000 });
    } finally {
      mcpServer.stop(true);
    }
  });

  test('fake-runner dispatch names bound servers; unbind revokes on the next dispatch', async ({ page }) => {
    // two full runner cycles + six navigations: the 2-run count wait must fit
    // inside the test budget (the per-test default is already 60s)
    test.setTimeout(120_000);
    const tasks = new TasksPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);
    const serverName = `E2E Dispatch ${tag}`;
    const serverId = await seedServer(page, serverName, `http://127.0.0.1:9/${tag}`);
    await bindServer(page, employeeId, serverId);

    const taskTitle = `MCPD ${tag}`;
    // born-ineligible seeding — the 5s auto-dispatch tick must not claim the
    // task while the drawer's Dispatch-now verb is being clicked (#387 class)
    const row = await createTaskWithHeldScan(page, tasks, taskTitle, employeeId);
    await expect(row).toContainText(employeeName, { timeout: 10_000 });

    // dispatch #1 through the workflow drawer — the plan carries the binding
    const drawer = await tasks.openWorkflowDrawer(row);
    const dispatch = drawer.getByTestId('drawer-verb-dispatch');
    // 20s: a cold e2e database renders the gate data (statuses, run state) slowly
    await expect(dispatch).toBeVisible({ timeout: 20_000 });
    await dispatch.click();
    await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 10_000 });
    // the fake runner settles; its RESULT line completes the task (terminal)
    await expect(drawer.getByText(/Run completed/i)).toBeVisible({ timeout: 45_000 });

    // run output names the bound server (SPEC fake-runner parity format)
    await page.goto('/tasks');
    await waitForHydration(page);
    const link = page.getByRole('link', { name: taskTitle }).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
    const taskId = page.url().split('?')[0]!.split('/').pop() as string;
    await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 15_000 });
    const folds = page.getByText(/Full output from/);
    await expect(folds.first()).toBeVisible({ timeout: 15_000 });
    for (const fold of await folds.all()) await fold.click();
    await expect(page.getByText(`[mcp] servers: ${serverName}`)).toBeVisible({ timeout: 15_000 });

    // unbind = revoke (SPEC) — via the editor's binding row, confirmed inline
    const { editor, bindingRow } = await openMcpSection(page, employeeName);
    await bindingRow.getByRole('button', { name: `Unbind ${serverName}` }).click();
    await bindingRow.getByRole('button', { name: 'Unbind', exact: true }).click();
    await expect(editor.getByTestId('mcp-binding-row')).toHaveCount(0, { timeout: 15_000 });
    await tasks.dismissOverlay('New employee');

    // the RESULT settle left the task terminal — manual status is free (owner
    // law 2026-10-27), flip it back to the ready category and re-dispatch.
    // Hold BEFORE the flip (a terminal task is scan-ineligible, so that write
    // has no window) and re-hold AFTER it: if a status move ever resets the
    // ladder, the seed restores the hold rather than pinning that unspecced
    // invariant; the flip→re-hold gap is one RPC round-trip, far inside the 5s
    // scan cadence (#387 class).
    await holdDispatchScan(taskId);
    const setStatus = await rpcPost(page, '/rpc/tasks/setStatus', { id: taskId, status: await readyStatusId() });
    expect(setStatus.status).toBe(200);
    await holdDispatchScan(taskId);
    const run2 = await rpcPost(page, '/rpc/tasks/dispatch', { taskId });
    expect(run2.status).toBe(200);
    // a 200 can be a lost-claim no-op (runId null) — the run itself must exist
    expect((run2.json as { runId?: string | null } | undefined)?.runId, 'dispatch #2 started a run').toBeTruthy();

    // dispatch #2's turn settles — back to the task page (the editor step left
    // us on /employees) — assert on the RAW OUTPUT surfaces: open every run's
    // output fold (each fetches its transcript on first open) and require
    // exactly ONE (the bound run) to name the server. Whole-page count asserts
    // raced the folds' open/toggle + lazy-fetch state; per-fold pre inspection
    // is deterministic. Unbind = revoke: run 2 must NOT name the server.
    await page.goto(`/tasks/${taskId}`);
    await waitForHydration(page);
    await expect(page.getByText('Completed')).toHaveCount(2, { timeout: 60_000 });
    const outFolds = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Full output from' }) });
    await expect(outFolds).toHaveCount(2, { timeout: 15_000 });
    for (let i = 0; i < 2; i++) {
      await outFolds.nth(i).locator('summary').click();
      await expect(outFolds.nth(i).locator('pre').first()).not.toBeEmpty({ timeout: 15_000 });
    }
    const foldsNamingServer = await outFolds
      .locator('pre')
      .evaluateAll(
        (pres, name: string) => pres.filter((p) => (p.textContent ?? '').includes(`[mcp] servers: ${name}`)).length,
        serverName,
      );
    expect(foldsNamingServer).toBe(1);
  });

  test('registry-page binding manager (#274): bind/unbind + credential set from /mcp; both surfaces stay in sync', async ({
    page,
  }) => {
    const mcp = new McpPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const serverName = `E2E BindPage ${tag}`;
    const serverId = await seedServer(page, serverName, `http://127.0.0.1:9/${tag}`);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);
    const { employeeName: emp2Name } = await seedAiEmployee(page, `${tag}x`);
    await seedSecret(page, tag);

    await mcp.open();
    await mcp.rowFor(serverName).getByTestId('mcp-manage-bindings').click();
    const dialog = page.getByRole('dialog', { name: `Bindings — ${serverName}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('mcp-server-bindings')).toContainText('No agents bound');

    // bind from the /mcp page: pick the agent + a vault credential, submit
    await dialog.getByTestId('mcp-bind-employee').click();
    await page.getByRole('option', { name: employeeName, exact: true }).click();
    await dialog.getByTestId('mcp-bind-secret').click();
    await page.getByRole('option', { name: new RegExp(`MCP cred ${tag}`) }).click();
    await dialog.getByTestId('mcp-bind-submit').click();
    const bound1 = dialog.getByTestId(`mcp-server-binding-${employeeName}`);
    await expect(bound1).toBeVisible({ timeout: 15_000 });
    await expect(bound1.getByTestId('mcp-server-binding-cred')).toContainText(`MCP cred ${tag}`);
    await expect(bound1.getByTestId('mcp-server-binding-cred')).not.toContainText(`sk-e2e-mcp-${tag}`);

    // the employee editor reflects the /mcp-side binding (one data model)
    const { editor, bindingRow } = await openMcpSection(page, employeeName);
    await expect(bindingRow).toContainText(serverName);

    // LIVE sync: with the editor OPEN, a registry-side write publishes the
    // change bus and the open modal picks it up with zero interaction (SPEC
    // "Binding surfaces": both views stay in sync without a manual refresh)
    const server2Name = `E2E BindPage2 ${tag}`;
    const server2Id = await seedServer(page, server2Name, `http://127.0.0.1:9/${tag}b`);
    const bind2 = await rpcPost(page, '/rpc/mcp/bindingsSet', { employeeId, serverId: server2Id });
    expect(bind2.status).toBe(200);
    await expect(editor.locator('[data-testid="mcp-binding-row"]').filter({ hasText: server2Name })).toBeVisible({
      timeout: 15_000,
    });

    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toBeHidden({ timeout: 10_000 });

    // bind a second agent from the EDITOR side → the /mcp modal reflects it
    await page.goto('/employees');
    await waitForHydration(page);
    await page.getByPlaceholder('Search employees…').fill(emp2Name);
    const emp2Row = page.locator('tr:visible', { hasText: emp2Name }).first();
    await expect(emp2Row).toBeVisible({ timeout: 15_000 });
    await emp2Row.getByRole('button', { name: /Edit / }).click();
    const editor2 = page.getByRole('dialog', { name: 'Edit employee' });
    await expect(editor2).toBeVisible();
    // USelectMenu trigger renders as a button labelled by the form field
    await editor2.getByRole('button', { name: 'MCP servers' }).click();
    await page.getByRole('option', { name: serverName, exact: true }).click();
    await editor2.getByRole('button', { name: 'Bind', exact: true }).click();
    const editor2Row = editor2.getByTestId('mcp-binding-row').filter({ hasText: serverName });
    await expect(editor2Row).toBeVisible({ timeout: 15_000 });
    await editor2.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor2).toBeHidden({ timeout: 10_000 });

    await page.goto('/mcp');
    await waitForHydration(page);
    await mcp.rowFor(serverName).getByTestId('mcp-manage-bindings').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`mcp-server-binding-${emp2Name}`)).toBeVisible({ timeout: 15_000 });
    await expect(
      dialog.getByTestId(`mcp-server-binding-${emp2Name}`).getByTestId('mcp-server-binding-cred'),
    ).toContainText('No credential');

    // set the credential straight from the /mcp modal (write-only masked read)
    await dialog
      .getByTestId(`mcp-server-binding-${emp2Name}`)
      .getByRole('button', { name: new RegExp(`Credential for ${emp2Name}`) })
      .click();
    await page.getByRole('option', { name: new RegExp(`MCP cred ${tag}`) }).click();
    await expect(
      dialog.getByTestId(`mcp-server-binding-${emp2Name}`).getByTestId('mcp-server-binding-cred'),
    ).toContainText(`MCP cred ${tag}`, { timeout: 15_000 });

    // unbind emp2 from the /mcp modal — two-step confirm (parity with the
    // editor; the destructive click is not a single stray click)
    await dialog.getByTestId(`mcp-server-binding-${emp2Name}`).getByTestId('mcp-server-binding-unbind').click();
    await expect(dialog.getByTestId('mcp-server-binding-unbind-ask')).toBeVisible();
    await dialog.getByTestId('mcp-server-binding-unbind-confirm').click();
    await expect(dialog.getByTestId(`mcp-server-binding-${emp2Name}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(dialog.getByTestId(`mcp-server-binding-${employeeName}`)).toBeVisible();

    await page.goto('/employees');
    await waitForHydration(page);
    await page.getByPlaceholder('Search employees…').fill(emp2Name);
    const emp2RowAfter = page.locator('tr:visible', { hasText: emp2Name }).first();
    await emp2RowAfter.getByRole('button', { name: /Edit / }).click();
    const editor2After = page.getByRole('dialog', { name: 'Edit employee' });
    await expect(editor2After).toBeVisible();
    await expect(editor2After.getByTestId('mcp-binding-row')).toHaveCount(0, { timeout: 15_000 });

    // the registry entry carries the surviving binding (in-use guard stays armed)
    const regList = await rpcPost(page, '/rpc/mcp/registryList', {});
    const entry = (regList.json as { data: Array<{ id: string; bindingCount: number }> }).data.find(
      (r) => r.id === serverId,
    );
    expect(entry?.bindingCount).toBe(1);
  });

  test('stdio transport (slice 3): UI create, spawn-probe verdict, dispatch names the server', async ({ page }) => {
    const mcp = new McpPage(page);
    const tasks = new TasksPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);

    // the probe/dispatch subject: an absolute command spawning the init-stub on
    // the app-server host (the ACP stdio contract)
    const command = process.execPath;
    const stub = `${process.cwd()}/test/fixtures/mcp-stdio-ok.mjs`;
    const serverName = `E2E Stdio ${tag}`;
    await mcp.open();
    await mcp.createStdioServer({
      name: serverName,
      command,
      args: `${stub}\n--e2e\n${tag}`,
      credentialEnvVar: 'MCP_API_KEY',
      notes: 'stdio slice',
    });
    const row = mcp.rowFor(serverName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('stdio');
    await expect(row).toContainText(command);

    // the auth select is LOCKED to the static credential for stdio (oauth ∩ stdio refused)
    await row.getByRole('button', { name: /Edit / }).click();
    await page.getByTestId('mcp-auth-kind').click();
    await expect(page.getByRole('option', { name: /OAuth 2.0/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // rpc read shape: transport/command/args round-trip on the registry row
    const regList = await rpcPost(page, '/rpc/mcp/registryList', {});
    const entry = (regList.json as { data: Array<Record<string, unknown>> }).data.find((r) => r.name === serverName);
    expect(entry?.transport).toBe('stdio');
    expect(entry?.command).toBe(command);
    expect(entry?.args).toEqual([stub, '--e2e', tag]);
    const serverId = entry?.id as string;

    // bind + probe: the spawn handshake flips the verdict to OK
    const secretId = await seedSecret(page, tag);
    await bindServer(page, employeeId, serverId, secretId);
    const { editor, bindingRow } = await openMcpSection(page, employeeName);
    await expect(bindingRow.getByTestId('mcp-probe-never')).toBeVisible();
    await bindingRow.getByRole('button', { name: `Probe ${serverName}` }).click();
    await expect(bindingRow.getByTestId('mcp-probe-ok')).toBeVisible({ timeout: 15_000 });
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toBeHidden({ timeout: 10_000 });

    // fake-runner dispatch names the stdio server in the run output (parity);
    // born-ineligible seeding keeps the 5s scan off the drawer's click (#387)
    const taskTitle = `MCPS ${tag}`;
    const taskRow = await createTaskWithHeldScan(page, tasks, taskTitle, employeeId);
    await expect(taskRow).toContainText(employeeName, { timeout: 10_000 });
    const drawer = await tasks.openWorkflowDrawer(taskRow);
    const dispatch = drawer.getByTestId('drawer-verb-dispatch');
    await expect(dispatch).toBeVisible({ timeout: 20_000 });
    await dispatch.click();
    await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByText(/Run completed/i)).toBeVisible({ timeout: 45_000 });

    await page.goto('/tasks');
    await waitForHydration(page);
    const link = page.getByRole('link', { name: taskTitle }).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 15_000 });
    const outFolds = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Full output from' }) });
    await expect(outFolds.first()).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < (await outFolds.count()); i++) {
      await outFolds.nth(i).locator('summary').click();
      await expect(outFolds.nth(i).locator('pre').first()).not.toBeEmpty({ timeout: 15_000 });
    }
    // run output appears on MULTIPLE surfaces (turn body span + fold pre) — a
    // whole-page getByText strict-violates; assert the fold pres (run-fold law)
    const anyFoldNamesServer = await outFolds
      .locator('pre')
      .evaluateAll(
        (pres, name: string) => pres.some((p) => (p.textContent ?? '').includes(`[mcp] servers: ${name}`)),
        serverName,
      );
    expect(anyFoldNamesServer).toBe(true);
  });
});
