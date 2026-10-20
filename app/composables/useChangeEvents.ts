import { useQueryClient } from '@tanstack/vue-query';
// SSE law (AGENTS.md): initial data comes from conventional GET queries; this
// subscription is ONLY the post-load updater — the server streams what changed
// ({ resource, action }) and we invalidate the matching query prefixes so the
// GET queries refetch. One connection per client, opened after mount,
// reconnected with a short backoff when the stream drops.
export function useChangeEvents() {
  // SSR arm — the events channel only exists in the browser; the server never
  // opens a persistent stream (SSE never serves the first load). Covered by
  // Playwright e2e in the browser.
  /* v8 ignore start */
  if (import.meta.server) return;
  /* v8 ignore stop */
  const { $client } = useNuxtApp();
  const queryClient = useQueryClient();
  let stopped = false;
  const controller = new AbortController();

  void (async () => {
    while (!stopped) {
      try {
        const iter = await (
          $client as unknown as {
            changes: {
              live: (
                input: undefined,
                opts: { signal: AbortSignal },
              ) => Promise<AsyncIterable<{ resource: string; action: string }>>;
            };
          }
        ).changes.live(undefined, { signal: controller.signal });
        for await (const evt of iter) {
          void queryClient.invalidateQueries({ queryKey: [evt.resource] });
        }
      } catch {
        // stream dropped (server restart, network) — reconnect below
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  onScopeDispose(() => {
    stopped = true;
    controller.abort();
  });
}
