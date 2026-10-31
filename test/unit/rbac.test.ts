// RBAC (SPEC "Roles & access"): the role gate is the procedure definition —
// behavior tests on the kernel procedures + a wiring scan that keeps every
// router file on its contracted tier (a bare protectedProcedure on a gated
// write is a defect even if no client ever calls it).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createProcedureClient } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import { ROLE } from '#shared/enums';

import { adminProcedure, employeeProcedure, protectedProcedure } from '../../server/domains/kernel/kernel';

const DOMAINS = join(import.meta.dirname, '../../server/domains');

function ctxWith(role: string | null) {
  return {
    reqHeaders: undefined,
    getSession: async () =>
      role === null ? null : { user: { id: 'u1', name: 'Test', email: 't@x.io', role: role as never } },
  };
}

/** oRPC beta.44: the (initial) context rides the client options, not the call */
function clientFor(proc: unknown, role: string | null) {
  return createProcedureClient(
    proc as never,
    {
      context: ctxWith(role),
    } as never,
  ) as (input?: unknown) => Promise<unknown>;
}

describe('kernel role gate (behavior)', () => {
  it.each([
    ['adminProcedure', adminProcedure],
    ['employeeProcedure', employeeProcedure],
    ['protectedProcedure', protectedProcedure],
  ] as const)('%s: anonymous -> UNAUTHORIZED', async (_name, proc) => {
    const client = clientFor(
      proc.handler(async () => 'ok'),
      null,
    );
    await expect(client()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each([
    ['adminProcedure', adminProcedure, [ROLE.ADMIN]],
    ['employeeProcedure', employeeProcedure, [ROLE.EMPLOYEE, ROLE.ADMIN]],
    ['protectedProcedure', protectedProcedure, [ROLE.ADMIN, ROLE.EMPLOYEE, ROLE.VIEWER]],
  ] as const)('%s: role matrix', async (_name, proc, allowed) => {
    for (const role of [ROLE.ADMIN, ROLE.EMPLOYEE, ROLE.VIEWER]) {
      const client = clientFor(
        proc.handler(async () => 'ok'),
        role,
      );
      if (allowed.includes(role)) {
        await expect(client()).resolves.toBe('ok');
      } else {
        await expect(client()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  it('role gate injects the resolved session downstream (401 before 403)', async () => {
    const client = clientFor(
      employeeProcedure.handler(async ({ context }) => context.session.user.id),
      ROLE.EMPLOYEE,
    );
    await expect(client()).resolves.toBe('u1');
  });
});

describe('router wiring scan (tiers per SPEC Roles & access)', () => {
  const read = (rel: string) => readFile(join(DOMAINS, rel), 'utf8');

  const EMPLOYEE_WRITES: Record<string, string[]> = {
    // work surface: every write is employee-tier (verdict writes below are
    // additionally human-gated — see HUMAN_WRITES)
    'tasks/tasks.router.ts': [
      'create',
      'update',
      'setStatus',
      'confirmProposal',
      'rejectProposal',
      'ask',
      'note',
      'forward',
      'answer',
      'submit',
      'abandon',
      'dispatch',
      'remove',
    ],
    'projects/projects.router.ts': ['create', 'update', 'remove'],
  };

  // REVIEW LAW: verdict writes are HUMAN-only — role gate + credential-origin
  // check (an API-key session is FORBIDDEN even with the right role)
  const HUMAN_WRITES: Record<string, string[]> = {
    'tasks/tasks.router.ts': ['approve', 'requestChanges', 'reject'],
  };

  const ADMIN_WRITES: Record<string, string[]> = {
    'statuses/statuses.router.ts': ['save', 'remove'],
    'settings/settings.router.ts': ['update'],
    'environments/environments.router.ts': ['create', 'update', 'remove', 'probe'],
    'employees/employees.router.ts': ['create', 'update', 'remove', 'createApiKey', 'updateApiKey', 'revokeApiKey'],
  };

  const ADMIN_ONLY_FILES = [
    'providers/providers.router.ts',
    'oidc/oidc.router.ts',
    'vault/secret/secret.router.ts',
    'vault/folder/folder.router.ts',
  ];

  it('work-surface writes are employee-gated', async () => {
    for (const [file, procs] of Object.entries(EMPLOYEE_WRITES)) {
      const src = await read(file);
      for (const p of procs) {
        expect(src, `${file}::${p} must be employeeProcedure`).toMatch(new RegExp(`${p}: employeeProcedure`));
      }
    }
  });

  it('verdict writes are human-gated (role + credential origin)', async () => {
    for (const [file, procs] of Object.entries(HUMAN_WRITES)) {
      const src = await read(file);
      for (const p of procs) {
        expect(src, `${file}::${p} must be humanProcedure`).toMatch(new RegExp(`${p}: humanProcedure`));
      }
    }
  });

  it('admin-surface writes are admin-gated; statuses.assign (Jev) stays employee', async () => {
    for (const [file, procs] of Object.entries(ADMIN_WRITES)) {
      const src = await read(file);
      for (const p of procs) {
        expect(src, `${file}::${p} must be adminProcedure`).toMatch(new RegExp(`${p}: adminProcedure`));
      }
    }
    const statuses = await read('statuses/statuses.router.ts');
    expect(statuses).toMatch(/assign: employeeProcedure/);
  });

  it('admin-only routers never wire a bare protectedProcedure', async () => {
    for (const file of ADMIN_ONLY_FILES) {
      const src = await read(file);
      expect(src, `${file} must not contain protectedProcedure`).not.toContain('protectedProcedure');
    }
  });

  it('reads stay session-tier (never admin-gated)', async () => {
    for (const [file, first] of [
      ['tasks/tasks.router.ts', 'list'],
      ['statuses/statuses.router.ts', 'list'],
      ['employees/employees.router.ts', 'list'],
    ] as const) {
      const src = await read(file);
      expect(src, `${file}::${first} must stay protectedProcedure`).toMatch(new RegExp(`${first}: protectedProcedure`));
    }
  });
});
