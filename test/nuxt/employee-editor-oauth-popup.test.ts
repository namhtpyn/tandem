import { mountSuspended } from '@nuxt/test-utils/runtime';
// #309: the editor modal's OAuth wiring, mount-level. The composable arms are
// pinned in use-mcp-oauth-connect.test.ts; this spec proves the MODAL surfaces
// the same arms end-to-end — a bindingsList row renders the Connect button,
// a blocked popup says why without spending the mint, and a rejected mint
// closes the popup and rides the modal's own alert banner. The REAL oRPC
// client runs; only the /rpc wire is stubbed (dispatch on URL content — the
// exact path shape is an oRPC wire detail).
import { expect, it, vi } from 'vitest';

import EmployeeEditorModal from '~/components/EmployeeEditorModal.vue';

const employee = {
  id: 'emp-oauth-test',
  name: 'Ada',
  email: 'ada@example.com',
  kind: 'ai',
  title: 'Bot',
} as never;

const oauthBinding = {
  id: 'b-oauth-test',
  serverId: 'srv-oauth-test',
  serverName: 'Test MCP',
  url: 'https://mcp.example',
  authKind: 'oauth',
  oauth: { connected: false, expiresAt: null },
  secretId: null,
  secretName: null,
  lastFour: null,
  lastProbeOk: null,
  lastProbeAt: null,
  lastProbeDetail: null,
};

function envelope(payload: unknown) {
  return new Response(JSON.stringify({ json: payload }), { headers: { 'content-type': 'application/json' } });
}

/** the one oauth binding the editor loads (unmapped rpc URLs fail loudly) */
function readCalls(url: string): Response | null {
  if (url.includes('bindingsList')) return envelope({ data: [oauthBinding], total: 1 });
  if (url.includes('oauthConnect')) return null; // the mint dispatch — each test owns it
  if (url.includes('registryList')) return envelope({ data: [], total: 0 });
  if (url.includes('titles')) return envelope({ titles: [] });
  if (url.includes('vault')) return envelope({ data: [], total: 0 });
  if (url.includes('environments')) return envelope([]);
  if (url.includes('providers')) return envelope([]);
  return null;
}

async function stubFetch(spend?: (url: string) => Response | null) {
  const realFetch = globalThis.fetch;
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/rpc/')) return realFetch(input, init);
    const res = spend?.(url) ?? readCalls(url);
    if (res !== null) return res;
    throw new Error(`unexpected rpc call: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

async function openEditor() {
  const c = await mountSuspended(EmployeeEditorModal, { props: { open: false, employee, rows: [] } });
  // the open false->true transition seeds the AI employee and enables the bindings query
  await c.setProps({ open: true });
  // UModal teleports to document.body — assert there, not on the wrapper
  await vi.waitFor(
    () => {
      expect(document.body.querySelector('[data-testid="mcp-oauth-connect"]')).not.toBeNull();
    },
    { timeout: 5_000 },
  );
  return c;
}

function clickConnect() {
  (document.body.querySelector('[data-testid="mcp-oauth-connect"]') as HTMLElement).click();
}

it('popup blocked: the modal says why, and no server-side mint is spent', async () => {
  const fetchStub = await stubFetch();
  vi.stubGlobal(
    'open',
    vi.fn(() => null),
  );
  const c = await openEditor();
  clickConnect();
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Popup blocked');
  });
  const mintCalls = fetchStub.mock.calls.filter(([input]) => String(input).includes('oauthConnect'));
  expect(mintCalls).toHaveLength(0);
  await c.unmount();
});

it('mint failure: the modal surfaces the rejection and closes the popup', async () => {
  const popup = { closed: false, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  await stubFetch((url) => {
    if (url.includes('oauthConnect')) throw new Error('mint rejected by test');
    return readCalls(url);
  });
  const c = await openEditor();
  clickConnect();
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('mint rejected by test');
  });
  expect(popup.close).toHaveBeenCalled();
  await c.unmount();
});
