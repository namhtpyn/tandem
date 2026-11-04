import { onBeforeUnmount, onMounted, ref } from 'vue';

import { errorMessage } from '~/utils/forms';

// Shared MCP OAuth connect flow (#270 slice 2, #274): the mint rides the
// admin-only oRPC POST `mcp.oauthConnect` (the legacy state-changing GET was
// the CSRF-intent vector: a SameSite=Lax admin session rides a forged
// top-level navigation, a cross-site POST does not). The popup opens
// SYNCHRONOUSLY in the click gesture (about:blank) and navigates to the
// provider URL only after the mint round-trip — a post-await window.open is
// popup-blocked. Provider authorize → Tandem callback stores the binding's
// tokens → the callback page postMessages `mcp-oauth` to this opener and the
// caller refetches its bindings (masked status only).
//
// Both admin surfaces (employee editor + registry-page binding manager) share
// this composable — one flow, no drift (SPEC "Binding surfaces" UI parity).
export function useMcpOauthConnect(onConnected: () => void | Promise<void>) {
  const { $client } = useNuxtApp();
  const connectingServerId = ref<string | null>(null);
  // `employeeId:serverId` of the in-flight mint — surfaces that serve MANY
  // bindings (the registry modal) key their per-row spinners by the pair;
  // single-agent surfaces key on connectingServerId alone
  const connectingKey = ref<string | null>(null);
  const connectError = ref<string | null>(null);
  let connectPopupWatcher: number | null = null;

  function stopConnectWatcher() {
    if (connectPopupWatcher !== null) {
      window.clearInterval(connectPopupWatcher);
      connectPopupWatcher = null;
    }
  }

  function clearConnecting() {
    connectingServerId.value = null;
    connectingKey.value = null;
  }

  /* v8 ignore start -- executed by the postMessage tests below; per-test
   * module copies + last-copy-wins coverage merging hide the arms
   * (same phantom as useChangeEvents, owner ruling 2026-10-27: (b)) */
  function onOauthMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { type?: string } | null;
    if (data?.type !== 'mcp-oauth') return;
    clearConnecting();
    stopConnectWatcher();
    void onConnected();
  }

  onMounted(() => window.addEventListener('message', onOauthMessage));
  onBeforeUnmount(() => {
    window.removeEventListener('message', onOauthMessage);
    stopConnectWatcher();
  });
  /* v8 ignore end */

  function connectOauth(employeeId: string, serverId: string) {
    if (connectingServerId.value) return;
    // a retry must not sit under a stale attempt's error (bind/unbind pattern)
    connectError.value = null;
    connectingServerId.value = serverId;
    connectingKey.value = `${employeeId}:${serverId}`;
    // gesture-safe open first — about:blank is same-origin, the opener may
    // navigate it to the provider URL once the mint resolves
    const popup = window.open('', 'mcp-oauth-connect', 'popup,width=520,height=680');
    if (!popup) {
      // popup blocked — no window to navigate, no server-side mint to spend;
      // a dead-looking Connect button reads as broken, so say why
      connectError.value = 'Popup blocked — allow popups for this site, then connect again';
      clearConnecting();
      return;
    }
    // a cancelled/closed popup never postMessages — stop the spinner so the
    // Connect button stays usable (reopening was the only recovery before)
    stopConnectWatcher();
    /* v8 ignore start -- interval body + navigate arm run in the dead-popup
     * and mint-success tests; the merge hides them (useChangeEvents phantom) */
    connectPopupWatcher = window.setInterval(() => {
      if (!popup || popup.closed) {
        stopConnectWatcher();
        clearConnecting();
      }
    }, 500);
    void $client.mcp
      .oauthConnect({ employeeId, serverId })
      .then((res) => {
        if (!popup || popup.closed) return;
        popup.location.href = res.connectUrl;
      })
      /* v8 ignore end */
      .catch((e) => {
        popup?.close();
        stopConnectWatcher();
        clearConnecting();
        // surface the mint rejection — the deleted REST route used to render
        // the message inside the popup; a silent flash-close reads as a glitch
        connectError.value = errorMessage(e, "Couldn't start the OAuth connect — try again");
      });
  }

  return { connectingServerId, connectingKey, connectError, connectOauth };
}
