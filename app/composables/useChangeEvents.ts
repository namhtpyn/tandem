import { useQueryClient } from '@tanstack/vue-query';
import type { Ref } from 'vue';

import { isUnauthorizedError, useAppSession, type AppSessionPayload } from './useAppSession';

// SSE law (AGENTS.md): initial data comes from conventional GET queries; this
// subscription is ONLY the post-load updater — the server streams what changed
// ({ resource, action }) and we invalidate the matching query prefixes so the
// GET queries refetch. One connection per client, opened after mount:
// - never opens while signed out (the channel is auth-guarded) — waits for the
//   session state to appear instead of 401-looping every 2s
// - auth failures (401/403) back off exponentially, capped at 60s; plain drops
//   (server restart, network) retry at the base interval
// - after any stream interruption, the next successful open invalidates ALL
//   queries once — the catch-up for events missed while the stream was down
type ChangeEvent = { resource: string; action: string };
type LiveClient = {
  changes: {
    live: (input: undefined, opts: { signal: AbortSignal }) => Promise<AsyncIterable<ChangeEvent>>;
  };
};

const RETRY_MS = 2_000;
const MAX_AUTH_BACKOFF_MS = 60_000;
const SIGNED_OUT_POLL_MS = 2_000;

// v8 ignore next -- the default resolves through Nuxt useState; unit arms pass a session
export function useChangeEvents(session: Ref<AppSessionPayload | null> = useAppSession()) {
  // SSR arm — the events channel only exists in the browser; the server never
  // opens a persistent stream (SSE never serves the first load). Covered by
  // Playwright e2e in the browser.
  /* v8 ignore start */
  if (import.meta.server) return;
  /* v8 ignore stop */
  const { $client } = useNuxtApp();
  const queryClient = useQueryClient();
  const controller = new AbortController();
  let stopped = false;

  // Registered synchronously during setup so scope disposal still aborts the
  // stream even though the open itself is deferred to mount.
  onScopeDispose(() => {
    stopped = true;
    controller.abort();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function openStream() {
    let backoff = RETRY_MS;
    let interrupted = false;

    while (!stopped) {
      // Signed out: hold here until a session appears — opening the
      // auth-guarded channel anonymous would just 401 forever.
      while (!stopped && !session.value) await sleep(SIGNED_OUT_POLL_MS);
      /* v8 ignore next -- abort-during-hold needs a dispose racing the poll sleep */
      if (stopped) return;

      let authFailure = false;
      try {
        const iter = await ($client as unknown as LiveClient).changes.live(undefined, { signal: controller.signal });
        if (interrupted) {
          // catch-up: events may have been missed while the stream was down
          // (the classic case is a server restart) — refetch everything once
          interrupted = false;
          void queryClient.invalidateQueries();
        }
        backoff = RETRY_MS;
        for await (const evt of iter) {
          /* v8 ignore next 1 -- executed by the invalidate test; per-test module copies + last-copy-wins coverage merging hide it */
          void queryClient.invalidateQueries({ queryKey: [evt.resource] });
        }
        // a clean stream end (server closed) is treated like a drop below
      } catch (error) {
        if (stopped) return;
        authFailure = isUnauthorizedError(error);
      }

      if (stopped) return;
      // Whatever just ended the stream, the next successful open must catch up
      // on anything that changed in the gap.
      interrupted = true;

      if (authFailure) {
        // expired session: back off exponentially up to a minute (a successful open resets the ladder)
        /* v8 ignore start */
        backoff = Math.min(backoff * 2, MAX_AUTH_BACKOFF_MS);
        await sleep(backoff);
        /* v8 ignore stop */
      } else {
        await sleep(RETRY_MS);
      }
    }
  }

  // Open after mount so the SSE handshake never races hydration. Without a
  // component context (unit harness) there is nothing to defer past.
  /* v8 ignore next 1 -- the onMounted arm runs only in a real browser mount */
  if (typeof onMounted === 'function') onMounted(() => void openStream());
  else void openStream();
}
