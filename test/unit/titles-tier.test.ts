// Titles catalog is admin-tier (#174): titles.save renames EVERY employee
// holding the old title (free-text cascade, no FK) — a write below its tier is
// a defect by definition (SPEC "Roles & access"). Pins the gate on the REAL
// router proc; the admin cascade through the live db is e2e-pinned
// (employees-titles.spec.ts, no-real-DB law keeps the unit project db-free).
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import { ROLE } from '#shared/enums';

import { employeesRouter } from '../../server/domains/employees/employees.router';

const save = employeesRouter.titles.save;

function clientFor(role: string | null) {
  return createProcedureClient(
    save as never,
    {
      context: {
        reqHeaders: undefined,
        getSession: async () =>
          role === null
            ? null
            : {
                sessionId: 'unit-session-row',
                user: { id: 'u1', name: 'Unit', email: 'unit@tandem.local', role: role as never },
              },
      },
    } as never,
  ) as (input?: unknown) => Promise<unknown>;
}

describe('titles.save tier (#174)', () => {
  it('anonymous -> UNAUTHORIZED (gate fires before the handler)', async () => {
    await expect(clientFor(null)({ id: 't1', name: 'X' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('VIEWER and EMPLOYEE -> FORBIDDEN (write tier)', async () => {
    await expect(clientFor(ROLE.VIEWER)({ id: 't1', name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(clientFor(ROLE.EMPLOYEE)({ id: 't1', name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
