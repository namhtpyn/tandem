// TEXT-STORABILITY LAW (#377, SPEC "API law"): Postgres text cannot store NUL
// or an unpaired surrogate — a name carrying either 500'd at the `"user"`
// insert before any access key was minted. The employee schema edge refuses it
// (BAD_REQUEST, field-named message) while a well-formed astral pair stays
// accepted. Handler-level pins run the REAL oRPC procedures: input validation
// fires before any db access, so the unit project stays db-free.
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import { ROLE } from '#shared/enums';
import { hasUnstorableText } from '#shared/utils/storable-text';

import { storableOptionalText, storableText } from '../../server/domains/employees/employee-text';
import { employeesRouter } from '../../server/domains/employees/employees.router';

const NUL = 'A\u0000B';
const LONE_HIGH = 'A\uD800B';
const LONE_LOW = 'A\uDC00B';
const ASTRAL = 'A😀B';

const adminSession = {
  sessionId: 'unit-session-row',
  user: { id: 'u1', name: 'Unit', email: 'unit@tandem.local', role: ROLE.ADMIN },
} as const;

function adminClient(procedure: unknown) {
  return createProcedureClient(
    procedure as never,
    {
      context: {
        reqHeaders: undefined,
        getSession: async () => adminSession,
      },
    } as never,
  ) as (input: unknown) => Promise<unknown>;
}

const create = adminClient(employeesRouter.create);
const update = adminClient(employeesRouter.update);
const saveTitle = adminClient(employeesRouter.titles.save);

const createInput = (name: string) => ({
  name,
  email: 'nul-name@tandem.local',
  kind: 'human' as const,
  title: 'Engineer',
  supervisorIds: [],
});

const updateInput = (name: string) => ({
  id: '01a14743-43f4-7053-a698-5b4ef36ed046',
  name,
  title: 'Engineer',
  supervisorIds: [],
});

describe('hasUnstorableText — the one predicate (SPEC TEXT-STORABILITY LAW)', () => {
  it('refuses NUL and unpaired surrogates', () => {
    expect(hasUnstorableText(NUL)).toBe(true);
    expect(hasUnstorableText(LONE_HIGH)).toBe(true);
    expect(hasUnstorableText(LONE_LOW)).toBe(true);
    // a valid pair followed by an orphan low surrogate is still unstorable
    expect(hasUnstorableText('😀\uDC00')).toBe(true);
    // an orphan low surrogate before a valid pair is unstorable too
    expect(hasUnstorableText('\uDC00😀')).toBe(true);
  });

  it('accepts ordinary text and well-formed surrogate pairs (astral characters)', () => {
    expect(hasUnstorableText('Ada Lovelace')).toBe(false);
    expect(hasUnstorableText(ASTRAL)).toBe(false);
    expect(hasUnstorableText('😀')).toBe(false);
    expect(hasUnstorableText('')).toBe(false);
  });
});

describe('employee text schemas (#377)', () => {
  it('accepts an astral name — a well-formed pair is storable', () => {
    expect(storableText('name', 100).parse(ASTRAL)).toBe(ASTRAL);
    expect(storableOptionalText('instructions', 10_000).parse(ASTRAL)).toBe(ASTRAL);
  });

  it('refuses NUL and lone surrogates with a field-named message', () => {
    for (const bad of [NUL, LONE_HIGH, LONE_LOW]) {
      expect(() => storableText('name', 100).parse(bad)).toThrow(
        /name contains invalid characters \(NUL or a lone surrogate\)/,
      );
      expect(() => storableOptionalText('model', 200).parse(bad)).toThrow(
        /model contains invalid characters \(NUL or a lone surrogate\)/,
      );
    }
  });
});

describe('employees.create — unstorable name/title answers BAD_REQUEST, never a 500 (#377)', () => {
  it('refuses a NUL in name before any user insert', async () => {
    await expect(create(createInput(NUL))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a lone surrogate in name', async () => {
    await expect(create(createInput(LONE_HIGH))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an unstorable title', async () => {
    await expect(create({ ...createInput('Ada'), title: NUL })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('employees.update — unstorable name answers BAD_REQUEST (#377)', () => {
  it('refuses a NUL in name', async () => {
    await expect(update(updateInput(NUL))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a lone low surrogate in name', async () => {
    await expect(update(updateInput(LONE_LOW))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('employees.titles.save — unstorable catalog name answers BAD_REQUEST (#377)', () => {
  it('refuses a NUL name', async () => {
    await expect(saveTitle({ name: NUL })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
