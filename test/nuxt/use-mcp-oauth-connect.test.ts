import { mountSuspended } from '@nuxt/test-utils/runtime';
// Coverage for the shared MCP OAuth connect flow (useMcpOauthConnect) — the
// popup-mint arms BOTH admin surfaces run. The nuxt env has no reachable /rpc
// backend, so the mint POST rejects. Pins: popup-blocked (no mint spend,
// blocked message), mint-failure (popup closed + error surfaced), the
// origin-guarded postMessage success arm, the dead-popup watcher arm, and the
// cross-origin message guard.
import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { useMcpOauthConnect } from '~/composables/use-mcp-oauth-connect';

type Flow = ReturnType<typeof useMcpOauthConnect>;

declare global {
  // eslint-disable-next-line no-var -- window bridge for the harness
  var __flow: Flow | undefined;
  // eslint-disable-next-line no-var -- window bridge for the harness
  var __connected: number | undefined;
}

const Harness = defineComponent({
  setup() {
    const flow = useMcpOauthConnect(() => {
      window.__connected = (window.__connected ?? 0) + 1;
    });
    window.__flow = flow;
    return () => h('div', 'harness');
  },
});

let mounted: Awaited<ReturnType<typeof mountSuspended>> | null = null;

async function mountFlow(): Promise<Flow> {
  mounted = await mountSuspended(Harness);
  return window.__flow as Flow;
}

afterEach(async () => {
  // each mount registers a window message listener — unmount so later
  // dispatches only reach THIS test's harness
  if (mounted) await mounted.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.__flow = undefined;
  window.__connected = undefined;
});

it('popup-blocked: no window to navigate, no mint spent, spinner stays cleared', async () => {
  vi.stubGlobal(
    'open',
    vi.fn(() => null),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  expect(flow.connectingServerId.value).toBeNull();
  expect(flow.connectError.value).toContain('Popup blocked');
});

it('mint failure: popup closed, spinner cleared, error surfaced for the admin', async () => {
  const popup = { closed: false, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  // no backend in the nuxt env — the mint rejects and the flow must clean up
  await vi.waitFor(() => expect(flow.connectError.value).not.toBeNull(), { timeout: 5_000 });
  expect(flow.connectingServerId.value).toBeNull();
  expect(popup.close).toHaveBeenCalled();
});

it('callback postMessage (same-origin): spinner cleared, onConnected fired', async () => {
  const popup = { closed: false, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  // deliver the callback the way the real popup would — the in-flight mint
  // outcome is irrelevant to this arm
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mcp-oauth' },
    }),
  );
  expect(flow.connectingServerId.value).toBeNull();
  expect(window.__connected).toBeGreaterThanOrEqual(1);
});

it('cross-origin postMessage is ignored — no spinner clear, no callback', async () => {
  const popup = { closed: false, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  expect(flow.connectingServerId.value).toBe('srv-1');
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'https://evil.example',
      data: { type: 'mcp-oauth' },
    }),
  );
  expect(flow.connectingServerId.value).toBe('srv-1');
  expect(window.__connected).toBeUndefined();
});

it('a dead popup never postMessages — the watcher clears the spinner', async () => {
  vi.useFakeTimers();
  // the mint must stay PENDING — a real fetch would reject under the fake
  // timers and clear the spinner via the catch arm before the tick fires
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const popup = { closed: true, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  // past the 500ms watcher tick — the closed-popup arm fires even though the
  // in-flight mint never resolves under fake timers
  await vi.advanceTimersByTimeAsync(600);
  expect(flow.connectingServerId.value).toBeNull();
});

it('mint success: the popup navigates to the provider authorize URL', async () => {
  const popup = { closed: false, close: vi.fn(), location: { href: '' } };
  vi.stubGlobal(
    'open',
    vi.fn(() => popup),
  );
  // a resolved mint (oRPC { json } envelope over a stubbed fetch) — the popup
  // the admin opened is navigated to the provider; the spinner stays until
  // the callback postMessage arrives
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ json: { connectUrl: 'https://provider.example/authorize', serverName: 'srv' } }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    ),
  );
  const flow = await mountFlow();
  flow.connectOauth('emp-1', 'srv-1');
  await vi.waitFor(() => expect(popup.location.href).toBe('https://provider.example/authorize'), { timeout: 5_000 });
  expect(flow.connectingServerId.value).toBe('srv-1');
});
