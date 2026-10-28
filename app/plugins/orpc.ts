import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
// oRPC typed client + TanStack Query utils (official patterns):
// - Browser: RPCLink to /rpc (same origin)
// - SSR: createRouterClient — direct in-process calls, no HTTP hop
//   (orpc.dev "Optimizing SSR"); built per request so cookies/headers are
//   always the current request's; server code stays out of the client bundle
//   behind import.meta.server (build-time guard).
import type { RouterClient } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
// unused by design — the commented generictify notes below are the consumers
// oxlint-disable-next-line eslint/no-unused-vars
import type { Paths, PickDeep, Promisable } from 'type-fest';

import type { appRouter } from '#server/domains/app.router';

// DO NOT CLEAN THIS UP KEEP THE COMMENTS BELOW — they are the design notes for the generictify types, which are
// a work-in-progress. The types are not used yet, but they are a proof-of-concept for the generictify idea.
// The generictify types are intended to allow the client to specify which fields it wants from the server,

// type GenerictifyOrpcProcedure<
//   // oxlint-disable-next-line typescript/no-explicit-any
//   TProc extends (...args: any[]) => any,
//   TFieldsName extends string = 'fields',
// > = TProc extends (...args: [infer TFirstArg extends { [P in TFieldsName]: string[] }, ...infer TRestArgs]) => infer R
//   ? R extends Promisable<infer U extends Record<string, unknown>> //Record<TFirstArg[TFieldsName][number], unknown>
//     ? TFirstArg[TFieldsName][number] extends Paths<U>
//       ? <TSelect extends TFirstArg[TFieldsName][number]>(
//           first: Omit<TFirstArg, TFieldsName> & { [P in TFieldsName]: TSelect[] },
//           ...rest: TRestArgs
//         ) => R extends Promise<unknown> ? Promise<PickDeep<U, TSelect>> : PickDeep<U, TSelect>
//       : TProc
//     : TProc
//   : TProc;

// type GenerictifyOrpcClient<T extends Record<string, unknown>> = {
//   [TRouteName in keyof T]: T[TRouteName] extends Record<string, unknown>
//     ? GenerictifyOrpcClient<T[TRouteName]>
//     : // oxlint-disable-next-line typescript/no-explicit-any
//       T[TRouteName] extends (...args: any[]) => any
//       ? GenerictifyOrpcProcedure<T[TRouteName]>
//       : T[TRouteName];
// };

export default defineNuxtPlugin(async () => {
  let client: RouterClient<typeof appRouter>;

  if (import.meta.server) {
    const { createRouterClient } = await import('@orpc/server');
    // TWO import shapes, one per mode (v2.49.1 prod-500 lesson):
    //  - PROD build: LITERAL specifier — rollup resolves '#server/*' at build and
    //    inlines the router into the nitro output. A runtime '#server' import
    //    cannot resolve in the packaged image (no tsconfig paths there).
    //  - DEV: variable specifier + @vite-ignore — vite's client crawler chases
    //    literal '#server/...' imports into the client graph (the server guard
    //    is a runtime check there), so the specifier must stay opaque to it.
    // import.meta.dev is define-replaced per mode, so exactly one branch ships.
    if (import.meta.dev) {
      const routerSpec = '#server/domains/app.router';
      const serverRouterDev: typeof appRouter = (await import(/* @vite-ignore */ routerSpec)).appRouter;
      const ctxSpec = '#server/domains/kernel/context';
      const { buildServerContext } = await import(/* @vite-ignore */ ctxSpec);
      const event = useRequestEvent();
      client = createRouterClient(serverRouterDev, {
        context: buildServerContext(event?.headers),
      });
    } else {
      const { appRouter: serverRouter } = await import('#server/domains/app.router');
      const { buildServerContext } = await import('#server/domains/kernel/context');
      const event = useRequestEvent();
      client = createRouterClient(serverRouter, {
        context: buildServerContext(event?.headers),
      });
    }
  } else {
    client = createORPCClient(new RPCLink({ url: '/rpc' }));
  }

  const orpc = createTanstackQueryUtils(client);
  return { provide: { client, orpc } };
});
