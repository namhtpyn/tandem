// TEXT-STORABILITY LAW (#377, SPEC "API law"): Postgres text cannot store NUL
// or an unpaired surrogate — a NUL makes the driver throw (the 500 this law
// removes) and an unpaired surrogate is silently rewritten to U+FFFD, i.e.
// stored corruption. The employee schema edge refuses both classes
// (BAD_REQUEST, field-named message) while a well-formed astral pair stays
// accepted. Handler-level pins run the REAL oRPC procedures: input validation
// fires before any db access, so no row is ever written.
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
const removeTitle = adminClient(employeesRouter.titles.remove);

const createInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ada',
  email: 'text-storability@tandem.local',
  kind: 'human' as const,
  title: 'Engineer',
  supervisorIds: [],
  ...overrides,
});

const updateInput = (overrides: Record<string, unknown> = {}) => ({
  id: '01a14743-43f4-7053-a698-5b4ef36ed046',
  name: 'Ada',
  title: 'Engineer',
  supervisorIds: [],
  ...overrides,
});

/** the refusal a real oRPC call raises: BAD_REQUEST carrying the zod issues */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; data?: { issues?: { path?: (string | number)[]; message?: string }[] } };
  }
  throw new Error('the call resolved — an unstorable value was accepted');
}

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

  it('refuses both surrogate-range boundaries when they are unpaired', () => {
    // 0xDBFF is the LAST high surrogate, 0xDFFF the LAST low surrogate — a pin
    // on 0xD800/0xDC00 alone would survive an off-by-one in either range end
    expect(hasUnstorableText('\uDBFF')).toBe(true);
    expect(hasUnstorableText('\uDFFF')).toBe(true);
    expect(hasUnstorableText('\uD800\uDBFF')).toBe(true);
    expect(hasUnstorableText('\uDC00\uDFFF')).toBe(true);
  });

  it('accepts ordinary text and well-formed surrogate pairs (astral characters)', () => {
    expect(hasUnstorableText('Ada Lovelace')).toBe(false);
    expect(hasUnstorableText(ASTRAL)).toBe(false);
    expect(hasUnstorableText('😀')).toBe(false);
    expect(hasUnstorableText('')).toBe(false);
    // pairs at the extreme range ends are still valid pairs
    expect(hasUnstorableText('\uDBFF\uDC00')).toBe(false);
    expect(hasUnstorableText('\uD800\uDFFF')).toBe(false);
    // a high surrogate followed by a code point ABOVE the low range is still unpaired
    expect(hasUnstorableText('\uD800\uE000')).toBe(true);
    expect(hasUnstorableText('\uD800\uFFFF')).toBe(true);
  });

  it('accepts ordinary control characters — only NUL is unstorable', () => {
    expect(hasUnstorableText('line1\nline2\ta\rb')).toBe(false);
  });
});

describe('employee text schemas (#377)', () => {
  it('accepts an astral value — a well-formed pair is storable', () => {
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

  it('keeps the pre-existing blank/cap contract (storableText demands 1..max)', () => {
    expect(() => storableText('name', 3).parse('')).toThrow();
    expect(() => storableText('name', 3).parse('abcd')).toThrow();
    expect(storableText('name', 3).parse('abc')).toBe('abc');
  });

  it('storableOptionalText adds ONLY the storable refine — it never imposes a minimum', () => {
    expect(() => storableOptionalText('model', 3).parse('abcd')).toThrow();
    expect(storableOptionalText('model', 3).parse('')).toBe('');
    expect(storableOptionalText('model', 3).parse('abc')).toBe('abc');
  });
});

describe('employees.create — every text field is refused when unstorable (#377)', () => {
  const cases = ['name', 'title', 'instructions', 'model', 'image', 'environmentId', 'providerId', 'apiKeySecretId'];

  for (const field of cases) {
    it(`${field}: NUL and a lone surrogate answer BAD_REQUEST naming the field`, async () => {
      for (const bad of [NUL, LONE_HIGH]) {
        const value = field === 'image' ? `data:image/png;base64,AA${bad}BB` : bad;
        const error = await refusal(() => create(createInput({ [field]: value })));
        expect(error.code).toBe('BAD_REQUEST');
        expect(error.data?.issues).toContainEqual(
          expect.objectContaining({
            path: [field],
            message: expect.stringContaining(`${field} contains invalid characters`),
          }),
        );
      }
    });
  }

  it('still refuses a blank model (the min(1) contract is unchanged)', async () => {
    const error = await refusal(() => create(createInput({ model: '' })));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.data?.issues).toContainEqual(expect.objectContaining({ path: ['model'] }));
  });
});

describe('employees.update — every text field is refused when unstorable (#377)', () => {
  const cases = ['name', 'title', 'instructions', 'model', 'image', 'environmentId', 'providerId', 'apiKeySecretId'];

  for (const field of cases) {
    it(`${field}: NUL and a lone low surrogate answer BAD_REQUEST naming the field`, async () => {
      for (const bad of [NUL, LONE_LOW]) {
        const value = field === 'image' ? `data:image/png;base64,AA${bad}BB` : bad;
        const error = await refusal(() => update(updateInput({ [field]: value })));
        expect(error.code).toBe('BAD_REQUEST');
        expect(error.data?.issues).toContainEqual(
          expect.objectContaining({
            path: [field],
            message: expect.stringContaining(`${field} contains invalid characters`),
          }),
        );
      }
    });
  }
});

describe('employees.titles.save — the catalog name and text id are refused when unstorable (#377)', () => {
  it('refuses a NUL name and names the `name` input, not the catalog', async () => {
    const error = await refusal(() => saveTitle({ name: NUL }));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.data?.issues).toContainEqual(
      expect.objectContaining({ path: ['name'], message: expect.stringContaining('name contains invalid characters') }),
    );
  });

  it('refuses a NUL in the text-typed catalog id', async () => {
    const error = await refusal(() => saveTitle({ id: NUL, name: 'Engineer' }));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.data?.issues).toContainEqual(
      expect.objectContaining({ path: ['id'], message: expect.stringContaining('id contains invalid characters') }),
    );
  });

  it('refuses a NUL in the remove id — the sibling write answers BAD_REQUEST, never the driver 500', async () => {
    const error = await refusal(() => removeTitle({ id: NUL }));
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.data?.issues).toContainEqual(
      expect.objectContaining({ path: ['id'], message: expect.stringContaining('id contains invalid characters') }),
    );
  });
});

describe('procedure schemas — the pre-existing blankness contract (helper-swap pins)', () => {
  /** the compiled oRPC input schema — the exact object the edge validates with */
  const inputSchema = (procedure: unknown) =>
    (
      procedure as {
        '~orpc': {
          inputSchemas: {
            safeParse: (v: unknown) => { success: boolean };
          }[];
        };
      }
    )['~orpc'].inputSchemas[0];

  it('accepts a blank instructions box on create and update (optional text has no minimum)', () => {
    expect(inputSchema(employeesRouter.create).safeParse(createInput({ instructions: '' })).success).toBe(true);
    expect(inputSchema(employeesRouter.update).safeParse(updateInput({ instructions: '' })).success).toBe(true);
  });

  it('refuses a blank value on every non-blank field of every employee write', () => {
    const nonBlankFields = ['name', 'title', 'model', 'environmentId', 'providerId', 'apiKeySecretId'];
    for (const field of nonBlankFields) {
      expect(inputSchema(employeesRouter.create).safeParse(createInput({ [field]: '' })).success).toBe(false);
      expect(inputSchema(employeesRouter.update).safeParse(updateInput({ [field]: '' })).success).toBe(false);
    }
    expect(inputSchema(employeesRouter.titles.save).safeParse({ name: '' }).success).toBe(false);
    expect(inputSchema(employeesRouter.titles.remove).safeParse({ id: '' }).success).toBe(false);
  });

  it('keeps every call-site cap at its specced literal', () => {
    const accepts = (procedure: unknown, input: unknown) => inputSchema(procedure).safeParse(input).success;
    expect(accepts(employeesRouter.create, createInput({ name: 'N'.repeat(100) }))).toBe(true);
    expect(accepts(employeesRouter.create, createInput({ name: 'N'.repeat(101) }))).toBe(false);
    expect(accepts(employeesRouter.create, createInput({ title: 'T'.repeat(100) }))).toBe(true);
    expect(accepts(employeesRouter.create, createInput({ title: 'T'.repeat(101) }))).toBe(false);
    expect(accepts(employeesRouter.create, createInput({ model: 'M'.repeat(200) }))).toBe(true);
    expect(accepts(employeesRouter.create, createInput({ model: 'M'.repeat(201) }))).toBe(false);
    expect(accepts(employeesRouter.create, createInput({ instructions: 'I'.repeat(10_000) }))).toBe(true);
    expect(accepts(employeesRouter.create, createInput({ instructions: 'I'.repeat(10_001) }))).toBe(false);
    const PREFIX = 'data:image/png;base64,';
    expect(
      accepts(employeesRouter.create, createInput({ image: `${PREFIX}${'A'.repeat(300_000 - PREFIX.length)}` })),
    ).toBe(true);
    expect(
      accepts(employeesRouter.create, createInput({ image: `${PREFIX}${'A'.repeat(300_001 - PREFIX.length)}` })),
    ).toBe(false);
  });

  it('accepts an id-less title save (create) and a full-length supplied id (the uncapped guard branch)', () => {
    expect(inputSchema(employeesRouter.titles.save).safeParse({ name: 'Engineer' }).success).toBe(true);
    expect(inputSchema(employeesRouter.titles.save).safeParse({ id: 'x'.repeat(64), name: 'Engineer' }).success).toBe(
      true,
    );
  });

  it('accepts null on every clearable field and the empty avatar (the clear paths stay open)', () => {
    const accepts = (procedure: unknown, input: unknown) => inputSchema(procedure).safeParse(input).success;
    for (const field of ['providerId', 'model', 'apiKeySecretId', 'image']) {
      expect(accepts(employeesRouter.create, createInput({ [field]: null }))).toBe(true);
      expect(accepts(employeesRouter.update, updateInput({ [field]: null }))).toBe(true);
    }
    for (const field of ['environmentId', 'instructions']) {
      expect(accepts(employeesRouter.update, updateInput({ [field]: null }))).toBe(true);
    }
    // '' clears the avatar (the documented clear form) and stays legal on optional text
    expect(accepts(employeesRouter.create, createInput({ image: '' }))).toBe(true);
    expect(accepts(employeesRouter.update, updateInput({ image: '' }))).toBe(true);
  });

  it('refuses a blank text-typed id', () => {
    expect(inputSchema(employeesRouter.create).safeParse(createInput({ environmentId: '' })).success).toBe(false);
    expect(inputSchema(employeesRouter.update).safeParse(updateInput({ providerId: '' })).success).toBe(false);
    expect(inputSchema(employeesRouter.titles.save).safeParse({ id: '', name: 'Engineer' }).success).toBe(false);
  });
});
