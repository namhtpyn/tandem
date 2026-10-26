// Workflow-integrity fixes (audit): project cycle walk fails closed at the depth
// cap, /health/ready never leaks driver text, auth bodies are size-capped.
import { describe, expect, it, vi } from 'vitest';

import './api-harness';
import { ROLE } from '#shared/enums';

const admin = {
  id: '00000000-0000-7000-8000-cd5fca5e2d34',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
};

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('#server/domains/app.router');
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
  const { call } = await import('@orpc/server');
  const { buildServerContext } = await import('#server/domains/kernel/context');
  const context = buildServerContext(new Headers()) as Record<string, unknown>;
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin });
  return call(node as unknown as Parameters<typeof call>[0], input ?? {}, { context });
}


describe('GET /health/ready failure body', () => {
  it('returns { ok: false } only — the driver error goes to the server log, not the body', async () => {
    const { vi: v } = await import('vitest');
    v.resetModules();
    v.doMock('#server/db/index', async (importOriginal) => {
      const actual = await importOriginal<typeof import('#server/db/index')>();
      const failing = async () => {
        throw new Error('postgres.js 28P01 password authentication failed for user "tandem"');
      };
      return { ...actual, sqlClient: failing as unknown as typeof actual.sqlClient };
    });
    try {
      const mod = await import('#server/routes/health/ready.get.ts');
      const errorSpy = v.spyOn(mod.log, 'error').mockImplementation(() => {});
      const { makeEvent } = await import('./api-harness.ts');
      const e = makeEvent({ method: 'GET', url: '/health/ready' });
      const result = (await (mod.default as (x: unknown) => unknown)(e)) as Record<string, unknown>;
      expect(result).toEqual({ ok: false });
      expect((e.node.res as unknown as { statusCode: number }).statusCode).toBe(503);
      expect(JSON.stringify(result)).not.toContain('28P01');
      // the real error IS logged server-side
      expect(errorSpy.mock.calls.some((c) => c.map(String).join(' ').includes('28P01'))).toBe(true);
    } finally {
      v.doUnmock('#server/db/index');
      v.resetModules();
      await import('#server/db/index');
    }
  });
});

describe('auth route body cap', () => {
  it('rejects a POST body over 1MB with 413 before better-auth parses it', async () => {
    const { call } = await import('./api-harness.ts');
    await expect(
      call('#server/routes/auth/[...].ts', {
        method: 'POST',
        url: '/auth/sign-in/email',
        body: 'x'.repeat(1_000_001),
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('GET/HEAD are untouched by the body cap', async () => {
    const authMod = await import('#server/domains/auth/auth.service');
    const inst = await authMod.getAuth();
    const originalHandler = inst.handler;
    inst.handler = async () => new Response('{"ok":true}', { status: 200 });
    try {
      const { result, event } = await import('./api-harness.ts').then(({ call }) =>
        call('#server/routes/auth/[...].ts', { method: 'GET', url: '/auth/get-session' }),
      );
      expect(result).toBeTruthy();
      expect(event.node.res.statusCode).toBe(200);
    } finally {
      inst.handler = originalHandler;
    }
  });
});
