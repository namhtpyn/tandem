// Shared test helper: call an oRPC procedure directly (no HTTP, no RPCHandler)
// through the official `call()` API — same validation, middleware, and context
// plumbing as production, minus the transport. Session injection keeps the
// protected-procedure middleware testable per-user.
import { call } from '@orpc/server';

import { ROLE } from '../shared/enums';

type SessionUser = { id: string; name: string; email: string; role: ROLE.ADMIN | ROLE.EMPLOYEE | ROLE.VIEWER };

export type ProcCaller = {
  <T = unknown>(path: string, input?: unknown): Promise<T>;
  as<T = unknown>(user: SessionUser | null, path: string, input?: unknown): Promise<T>;
};

export async function makeProcCaller(sessionUser: SessionUser | null) {
  const { appRouter } = await import('../../server/domains/app.router');
  const { buildServerContext } = await import('../../server/domains/kernel/context');
  let current: SessionUser | null = sessionUser;

  const contextFor = async () => {
    const context = buildServerContext(new Headers()) as unknown as { getSession: () => Promise<unknown> };
    context.getSession = async () => (current ? { user: current } : null);
    return context;
  };

  const resolve = (path: string) => {
    let node: Record<string, unknown> = appRouter as unknown as Record<string, unknown>;
    for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
    return node as unknown as Parameters<typeof call>[0];
  };

  const fn = (async <T>(path: string, input?: unknown): Promise<T> => {
    return (await call(resolve(path), input ?? {}, { context: await contextFor() })) as T;
  }) as ProcCaller;
  (fn as unknown as { __setUser: (u: SessionUser | null) => void }).__setUser = (u) => {
    current = u;
  };
  fn.as = async <T>(user: SessionUser | null, path: string, input?: unknown) => {
    const prev = current;
    current = user;
    try {
      return (await call(resolve(path), input ?? {}, { context: await contextFor() })) as T;
    } finally {
      current = prev;
    }
  };
  return fn;
}
