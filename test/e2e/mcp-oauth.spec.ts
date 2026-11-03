// E2E: MCP OAuth per binding (SPEC "MCP (registry + per-agent bindings) —
// OAuth per binding (#270 slice 2)"). Covers: registry OAuth validation (400
// when the required endpoints are missing), the full authorize loop through
// the UI (Connect popup → mock provider → Tandem callback → connected badge),
// the probe riding the stored Bearer token, the fake-runner dispatch naming
// the oauth-bound server, and unbind = revoke (the mock provider sees the
// RFC 7009 revocation POST).
//
// The mock provider answers /authorize (302 back with code+state), /token
// (records the grant; requires PKCE verifier + client credentials),
// /revoke (records), and /mcp (JSON-RPC initialize that REQUIRES the Bearer
// token — a probe passing proves the token rode the request).
//
// The shared cleanup fixture sweeps users/tasks/environments/vault rows but
// NOT the mcp tables — the mcpSweep fixture below removes this file's oauth
// tokens/states, bindings and servers BEFORE the shared sweep (they reference
// the employee user that sweep deletes).
import { SQL } from 'bun';

import { expect, test as cleanupTest } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

const test = cleanupTest.extend<{ mcpSweep: void }>({
  // auto fixture, teardown-ordered BEFORE the shared dbCleanup sweep (fixtures
  // tear down LIFO): mcp_oauth_* + mcp_server_bindings join the employee user
  // and registry servers swept below — child rows must die first.
  mcpSweep: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures need a destructuring pattern
    async ({}, use) => {
      const startedAt = new Date();
      await use();
      const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
      const failures: string[] = [];
      try {
        for (const statement of [
          'delete from mcp_oauth_states where created_at >= $1',
          'delete from mcp_oauth_tokens where created_at >= $1',
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
      if (failures.length) throw new Error(`mcp oauth cleanup failed:\n${failures.join('\n')}`);
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
  return { status: res.status(), json: json.json as Record<string, unknown> | undefined };
}

/** AI employee on a throwaway environment — the dispatch/probe subject */
async function seedAiEmployee(page: import('@playwright/test').Page, tag: string) {
  const env = await rpcPost(page, '/rpc/environments/create', {
    name: `E2E MCP OAuth Env ${tag}`,
    host: '127.0.0.1',
    port: '22',
    username: 'e2e',
  });
  expect(env.status).toBe(200);
  const employeeName = `E2E OAuth Bot ${tag}`;
  const emp = await rpcPost(page, '/rpc/employees/create', {
    name: employeeName,
    email: `e2e-mcp-oauth-${tag}@tandem.local`,
    kind: 'ai',
    title: 'Runner',
    environmentId: env.json?.id,
    executable: 'hermes acp',
  });
  expect(emp.status).toBe(200);
  return { employeeId: emp.json?.id as string, employeeName };
}

async function seedOauthServer(
  page: import('@playwright/test').Page,
  name: string,
  provider: { port: number },
): Promise<string> {
  const res = await rpcPost(page, '/rpc/mcp/registryCreate', {
    name,
    url: `http://127.0.0.1:${provider.port}/mcp`,
    notes: '',
    authKind: 'oauth',
    oauthAuthorizeUrl: `http://127.0.0.1:${provider.port}/authorize`,
    oauthTokenUrl: `http://127.0.0.1:${provider.port}/token`,
    oauthRevocationUrl: `http://127.0.0.1:${provider.port}/revoke`,
    oauthClientId: 'e2e-client',
    oauthScopes: 'mcp',
  });
  expect(res.status).toBe(200);
  return res.json?.id as string;
}

async function bindServer(page: import('@playwright/test').Page, employeeId: string, serverId: string): Promise<void> {
  const res = await rpcPost(page, '/rpc/mcp/bindingsSet', { employeeId, serverId });
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

type RecordedGrant = Record<string, string>;

/** mock OAuth provider + MCP resource server sharing one Bun.serve port */
function startMockProvider() {
  const grants: RecordedGrant[] = [];
  const authorizeHits: Record<string, string>[] = [];
  const revokes: RecordedGrant[] = [];
  const bearerChecks: string[] = [];
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/authorize') {
        authorizeHits.push(Object.fromEntries(url.searchParams));
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: { location: `${redirect}?code=e2e-code-1&state=${encodeURIComponent(state)}` },
        });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await req.text());
        const grant: RecordedGrant = Object.fromEntries(params);
        grants.push(grant);
        const ok = grant.code === 'e2e-code-1' || grant.refresh_token === 'e2e-refresh-1';
        return new Response(
          JSON.stringify(
            ok
              ? { access_token: 'e2e-access-1', refresh_token: 'e2e-refresh-1', expires_in: 3600, scope: 'mcp' }
              : { error: 'invalid_grant', error_description: 'unknown code or refresh token' },
          ),
          { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        revokes.push(Object.fromEntries(new URLSearchParams(await req.text())));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        const auth = req.headers.get('authorization') ?? '';
        bearerChecks.push(auth);
        if (auth !== 'Bearer e2e-access-1') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized' } }),
            {
              status: 401,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'oauth-mcp', version: '1' },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    port: server.port as number,
    grants,
    authorizeHits,
    revokes,
    bearerChecks,
    stop: () => server.stop(true),
  };
}

test.describe('mcp oauth per binding', () => {
  test('registry OAuth validation: oauth requires authorize/token/clientId; none clears', async ({ page }) => {
    const tag = Date.now().toString(36).slice(-6);
    const missing = await rpcPost(page, '/rpc/mcp/registryCreate', {
      name: `E2E OAuth Bad ${tag}`,
      url: 'http://127.0.0.1:9/mcp',
      notes: '',
      authKind: 'oauth',
      oauthAuthorizeUrl: 'http://127.0.0.1:9/authorize',
    });
    expect(missing.status).toBe(400); // tokenUrl + clientId required (SPEC)

    const created = await rpcPost(page, '/rpc/mcp/registryCreate', {
      name: `E2E OAuth Ok ${tag}`,
      url: 'http://127.0.0.1:9/mcp',
      notes: '',
      authKind: 'oauth',
      oauthAuthorizeUrl: 'http://127.0.0.1:9/authorize',
      oauthTokenUrl: 'http://127.0.0.1:9/token',
      oauthClientId: 'client-x',
    });
    expect(created.status).toBe(200);
    const serverId = created.json?.id as string;

    // flipping back to none clears the whole oauth block (registry read is session-tier)
    const cleared = await rpcPost(page, '/rpc/mcp/registryUpdate', { id: serverId, authKind: 'none' });
    expect(cleared.status).toBe(200);
    const list = await rpcPost(page, '/rpc/mcp/registryList', {});
    expect(list.status).toBe(200);
    const listJson = list.json as unknown as
      | { data?: Array<{ id: string; authKind?: string; oauth?: { authorizeUrl?: string | null } }> }
      | undefined;
    const row = listJson?.data?.find((r) => r.id === serverId);
    expect(row?.authKind).toBe('none');
    expect(row?.oauth?.authorizeUrl ?? null).toBeNull();
  });

  test('authorize loop through the UI popup: connected badge, probe rides the Bearer, replayed state 400s', async ({
    page,
  }) => {
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);
    const provider = startMockProvider();
    const serverName = `E2E OAuth Probe ${tag}`;
    try {
      const serverId = await seedOauthServer(page, serverName, provider);
      await bindServer(page, employeeId, serverId);

      const { editor, bindingRow } = await openMcpSection(page, employeeName);
      // not connected yet — the badge + Connect button render
      await expect(bindingRow.getByTestId('mcp-oauth-status')).toContainText('Not connected');
      const connect = bindingRow.getByTestId('mcp-oauth-connect');
      await expect(connect).toBeVisible();

      // the Connect popup rides connect → provider authorize → callback result
      const popupPromise = page.waitForEvent('popup');
      await connect.click();
      const popup = await popupPromise;
      await expect(popup.getByText('Authorization complete')).toBeVisible({ timeout: 20_000 });
      await popup.close();

      // the opener refreshes via postMessage — the badge flips to Connected
      await expect(bindingRow.getByTestId('mcp-oauth-status')).toContainText('Connected', { timeout: 15_000 });

      // the grant carried PKCE + client identity + the deterministic redirect_uri
      expect(provider.grants).toHaveLength(1);
      const grant = provider.grants[0] as Record<string, string>;
      expect(grant.grant_type).toBe('authorization_code');
      expect(grant.code).toBe('e2e-code-1');
      expect(grant.client_id).toBe('e2e-client');
      expect(grant.code_verifier).toBeTruthy();
      expect(grant.redirect_uri).toContain('/api/mcp/oauth/callback');
      expect(provider.authorizeHits[0]?.code_challenge_method).toBe('S256');

      // probe → the mock resource server ONLY answers the stored Bearer token
      await bindingRow.getByRole('button', { name: `Probe ${serverName}` }).click();
      await expect(bindingRow.getByTestId('mcp-probe-ok')).toBeVisible({ timeout: 15_000 });
      expect(provider.bearerChecks).toContain('Bearer e2e-access-1');

      // state single-use: replaying the callback URL 400s on the result page
      const authorize = provider.authorizeHits[0] as Record<string, string>;
      const replay = await page.request.get(
        `${grant.redirect_uri}?code=e2e-code-1&state=${encodeURIComponent(authorize.state ?? '')}`,
      );
      expect(replay.status()).toBe(400);
      await expect(editor.getByRole('button', { name: 'Cancel' })).toBeVisible();
    } finally {
      provider.stop();
    }
  });

  test('fake-runner dispatch names the oauth server; unbind revokes at the provider', async ({ page }) => {
    const tasks = new TasksPage(page);
    const tag = Date.now().toString(36).slice(-6);
    const { employeeId, employeeName } = await seedAiEmployee(page, tag);
    const provider = startMockProvider();
    const serverName = `E2E OAuth Dispatch ${tag}`;
    try {
      const serverId = await seedOauthServer(page, serverName, provider);
      await bindServer(page, employeeId, serverId);

      // connect via the REST legs (no UI): connect → authorize → callback
      const connectRes = await page.request.get(
        `/api/mcp/oauth/connect?employeeId=${encodeURIComponent(employeeId)}&serverId=${encodeURIComponent(serverId)}`,
        { maxRedirects: 0 },
      );
      expect(connectRes.status()).toBe(302);
      const authorizeUrl = connectRes.headersArray().find((h) => h.name.toLowerCase() === 'location')?.value ?? '';
      expect(authorizeUrl).toContain(`127.0.0.1:${provider.port}/authorize`);
      const authRes = await page.request.get(authorizeUrl, { maxRedirects: 0 });
      expect(authRes.status()).toBe(302);
      const callbackUrl = authRes.headersArray().find((h) => h.name.toLowerCase() === 'location')?.value ?? '';
      expect(callbackUrl).toContain('/api/mcp/oauth/callback?code=e2e-code-1');
      const cbRes = await page.request.get(callbackUrl);
      expect(cbRes.status()).toBe(200);
      expect(await cbRes.text()).toContain('Authorization complete');
      expect(provider.grants).toHaveLength(1);

      // dispatch: the fake runner prints the plan the real runner would wire
      const taskTitle = `MCPO ${tag}`;
      await tasks.navigate('/tasks');
      await tasks.openCreateModal();
      await tasks.fillTaskForm({ title: taskTitle, assignee: employeeName });
      await tasks.saveTask();
      const row = tasks.rowFor(taskTitle);
      await expect(row).toBeVisible({ timeout: 15_000 });
      const drawer = await tasks.openWorkflowDrawer(row);
      const dispatch = drawer.getByTestId('drawer-verb-dispatch');
      // auto-dispatch-on-create races this verb: when the task auto-fired the
      // drawer shows the live run instead — either way the run completes
      try {
        await dispatch.click({ timeout: 20_000, force: true });
        await expect(drawer.getByText('Agent dispatched')).toBeVisible({ timeout: 10_000 });
      } catch {
        /* already dispatched — the run is streaming */
      }
      await expect(drawer.getByText(/Run completed/i)).toBeVisible({ timeout: 45_000 });

      // run output names the oauth-bound server (SPEC fake-runner parity) —
      // asserted per-fold: the line renders on MULTIPLE surfaces (turn body +
      // fold pre) and whole-page asserts strict-mode-violate (#272 law)
      await page.goto('/tasks');
      await waitForHydration(page);
      const link = page.getByRole('link', { name: taskTitle }).first();
      await expect(link).toBeVisible({ timeout: 15_000 });
      await link.click();
      await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
      await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 15_000 });
      const folds = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Full output from' }) });
      await expect(folds.first()).toBeVisible({ timeout: 15_000 });
      for (let i = 0; i < (await folds.count()); i++) {
        await folds.nth(i).locator('summary').click();
        await expect(folds.nth(i).locator('pre').first()).not.toBeEmpty({ timeout: 15_000 });
      }
      const foldPre = folds.first().locator('pre').first();
      await expect(foldPre).toContainText(`[mcp] servers: ${serverName}`, { timeout: 15_000 });

      // unbind = revoke: the editor's two-step unbind, then the provider saw it
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
      await expect(bindingRow.getByTestId('mcp-oauth-status')).toContainText('Connected');
      await bindingRow.getByRole('button', { name: `Unbind ${serverName}` }).click();
      await bindingRow.getByRole('button', { name: 'Unbind', exact: true }).click();
      await expect(editor.getByTestId('mcp-binding-row')).toHaveCount(0, { timeout: 15_000 });
      // unbind = revoke: BOTH tokens revoke (the refresh token is the durable
      // grant) — the mock provider saw two RFC 7009 POSTs
      expect(provider.revokes).toHaveLength(2);
      expect(provider.revokes.map((r) => (r as Record<string, string>).token).sort()).toEqual([
        'e2e-access-1',
        'e2e-refresh-1',
      ]);
    } finally {
      provider.stop();
    }
  });
});
