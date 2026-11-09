import { os } from '@orpc/server';
// employees router — business logic lives in services/utils; this file only wires procedures
import { and, count, desc, EmptyFilter, eq, inArray, ne } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';
import { ROLE } from '#shared/enums';
import type { ApiKeyRow, EmployeeRow } from '#shared/types';
import { escapeIlike } from '#shared/utils/escape-ilike';
import { isUuid } from '#shared/utils/is-uuid';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import {
  aiEmployees as aiEmployeesTable,
  apikey as apikeyTable,
  employeeSupervisors as supervisorsTable,
  employeeTitles as employeeTitlesTable,
  environments as environmentsTable,
  modelProviders as modelProvidersTable,
  user as userTable,
  vaultSecrets as vaultSecretsTable,
} from '../../db/schema';
import { requireUuid } from '../kernel/id-shape';
import { ORPCError, adminProcedure, liveGenerator, protectedProcedure, publishChange } from '../kernel/kernel';
import { assertAccessKeyName, derivedAccessKeyName } from './access-key-name';

const ACP_EXECUTABLE_RE = /^[A-Za-z0-9_@/.-]+(?: [A-Za-z0-9_@/.-]+)*$/;

/** one cap for an employee's title and the catalog entry it points at — a longer
 *  catalog name could never be applied to an employee, so both share this */
const EMPLOYEE_TITLE_MAX = 100;

// avatar writes must be raster-image data URLs (svg/xml excluded — served with nosniff,
// never allowed to carry active content); '' / null still clear the avatar
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/;
const avatarImageSchema = z
  .string()
  .max(300_000)
  .refine((v) => !v || AVATAR_DATA_URL_RE.test(v), 'Avatar must be a base64 data URL image (png, jpeg, webp, or gif)')
  .nullable()
  .optional();

const assertNoDuplicateSupervisors = (supervisorIds: string[]) => {
  // uuid ids compare case-insensitively in Postgres — the duplicate check must too
  if (new Set(supervisorIds.map((s) => s.toLowerCase())).size !== supervisorIds.length)
    throw new ORPCError('BAD_REQUEST', { message: 'duplicate supervisor ids' });
};

/** supervisor ids land in employee_supervisors.supervisor_id (uuid): shape-check
 *  them at the edge (ID-SHAPE LAW) and canonicalize to the lowercase wire form so
 *  the JS comparisons (duplicate / self / cycle) agree with what Postgres stores */
const normalizeSupervisorIds = (supervisorIds: string[]): string[] => {
  for (const s of supervisorIds) requireUuid(s, 'BAD_REQUEST', 'invalid supervisor id');
  return supervisorIds.map((s) => s.toLowerCase());
};

const assertSupervisorsExist = async (supervisorIds: string[]) => {
  if (supervisorIds.length === 0) return;
  const found = await db.query.user.findMany({ columns: { id: true }, orderBy: { id: 'asc' } });
  const ids = new Set(found.map((f) => f.id.toLowerCase()));
  for (const s of supervisorIds) {
    if (!ids.has(s.toLowerCase())) throw new ORPCError('BAD_REQUEST', { message: `supervisor ${s} does not exist` });
  }
};

const assertEnvironmentExists = async (environmentId: string) => {
  const env = await db
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, environmentId));
  if (env.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'environment does not exist' });
};

const assertSecretExists = async (secretId: string) => {
  const sec = await db
    .select({ id: vaultSecretsTable.id })
    .from(vaultSecretsTable)
    .where(eq(vaultSecretsTable.id, secretId));
  if (sec.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'api key secret not found' });
};

const assertProviderExists = async (providerId: string) => {
  const prov = await db
    .select({ id: modelProvidersTable.id })
    .from(modelProvidersTable)
    .where(eq(modelProvidersTable.id, providerId));
  if (prov.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'provider does not exist' });
};

const assertEmailAvailable = async (email: string) => {
  const clash = await db.query.user.findMany({
    columns: { id: true },
    where: { email: { eq: email } },
    orderBy: { id: 'asc' },
  });
  if (clash.length > 0) throw new ORPCError('CONFLICT', { message: `user ${email} already exists` });
};

/** shell-safe ACP executable, trimmed */
const trimmedExecutable = (executable: string) => {
  if (!ACP_EXECUTABLE_RE.test(executable.trim()))
    throw new ORPCError('BAD_REQUEST', {
      message: 'ACP executable must be shell-safe command words, e.g. "hermes acp"',
    });
  return executable.trim();
};

/** create demands a non-blank ACP executable; update only re-validates a supplied one */
const requiredExecutable = (executable: string | undefined) => {
  if (!executable || !executable.trim())
    throw new ORPCError('BAD_REQUEST', {
      message: 'AI employees need an ACP executable (e.g. "hermes acp")',
    });
  return trimmedExecutable(executable);
};

/** mint an access key via better-auth (dynamic import keeps auth boot lazy) */
const mintAccessKey = async (name: string, userId: string) => {
  const { getAuth } = await import('../auth/auth.service');
  const auth = await getAuth();
  return auth.api.createApiKey({ body: { name, userId, prefix: 'tandem_' } });
};

/** candidate supervision edges on top of the existing graph (this employee's edges replaced) */
const assertAcyclicSupervision = async (employeeId: string, supervisorIds: string[]) => {
  const supRows = await db.query.employeeSupervisors.findMany({
    columns: { employeeId: true, supervisorId: true },
    orderBy: { employeeId: 'asc' },
  });
  const graph = new Map<string, string[]>();
  for (const r of supRows) {
    if (r.employeeId === employeeId) continue; // pretend the update applied
    nonNull(graph.get(r.employeeId) ?? graph.set(r.employeeId, []).get(r.employeeId)).push(r.supervisorId);
  }
  graph.set(employeeId, [...supervisorIds]);
  // DFS from each supervisor upward: reaching the employee again means a cycle
  const seen = new Set<string>();
  const stack = [...supervisorIds];
  while (stack.length > 0) {
    const cur = nonNull(stack.pop());
    if (cur === employeeId) throw new ORPCError('BAD_REQUEST', { message: 'supervision cycle detected' });
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(graph.get(cur) ?? []));
  }
};

/** the AI-extendable slice of the update input */
type AiExtensionPatchInput = {
  environmentId?: string | null;
  instructions?: string | null;
  executable?: string | null;
  providerId?: string | null;
  model?: string | null;
  apiKeySecretId?: string | null;
};

/** true when the update carries at least one AI extension field */
const hasAiExtensionField = (input: AiExtensionPatchInput) =>
  input.environmentId !== undefined ||
  input.instructions !== undefined ||
  input.executable !== undefined ||
  input.providerId !== undefined ||
  input.model !== undefined ||
  input.apiKeySecretId !== undefined;

/** validate + build the aiEmployees patch; absent fields stay untouched, nulls clear */
const aiExtensionPatch = async (input: AiExtensionPatchInput) => {
  const patch: {
    environmentId?: string;
    instructions?: string;
    executable?: string;
    providerId?: string | null;
    model?: string | null;
    apiKeySecretId?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.environmentId !== undefined && input.environmentId !== null) {
    await assertEnvironmentExists(input.environmentId);
    patch.environmentId = input.environmentId;
  }
  if (input.instructions !== undefined && input.instructions !== null) {
    patch.instructions = input.instructions;
  }
  if (input.executable !== undefined && input.executable !== null) {
    patch.executable = trimmedExecutable(input.executable);
  }
  if (input.providerId !== undefined) {
    if (input.providerId !== null) await assertProviderExists(input.providerId);
    patch.providerId = input.providerId;
  }
  if (input.model !== undefined) patch.model = input.model;
  if (input.apiKeySecretId !== undefined) {
    if (input.apiKeySecretId !== null) await assertSecretExists(input.apiKeySecretId);
    patch.apiKeySecretId = input.apiKeySecretId;
  }
  return patch;
};

/** user rows: identity + employment columns as selected by the list queries */
type EmployeeUserRow = Pick<
  typeof userTable.$inferSelect,
  'id' | 'name' | 'email' | 'image' | 'title' | 'createdAt' | 'updatedAt'
>;
type SupervisorEdge = Pick<typeof supervisorsTable.$inferSelect, 'employeeId' | 'supervisorId'>;
type AiExtensionRow = Pick<
  typeof aiEmployeesTable.$inferSelect,
  'userId' | 'environmentId' | 'executable' | 'providerId' | 'model' | 'apiKeySecretId' | 'instructions'
>;

/** shared row mapping: user identity + supervision edges + AI extension -> EmployeeRow */
const mapEmployeeRows = (users: EmployeeUserRow[], supRows: SupervisorEdge[], aiRows: AiExtensionRow[]) => {
  const sups = new Map<string, string[]>();
  for (const s of supRows) {
    nonNull(sups.get(s.employeeId) ?? sups.set(s.employeeId, []).get(s.employeeId)).push(s.supervisorId);
  }
  const aiByUser = new Map(aiRows.map((r) => [r.userId, r]));
  return users.map((r): EmployeeRow => {
    const ai = aiByUser.get(r.id);
    return {
      id: r.id,
      userId: r.id,
      name: r.name,
      email: r.email,
      hasAvatar: r.image !== null,
      // derived: extension row present => ai, absent => human
      kind: ai ? 'ai' : 'human',
      title: r.title,
      supervisorIds: sups.get(r.id) ?? [],
      environmentId: ai?.environmentId ?? null,
      executable: ai?.executable ?? null,
      providerId: ai?.providerId ?? null,
      model: ai?.model ?? null,
      apiKeySecretId: ai?.apiKeySecretId ?? null,
      instructions: ai?.instructions ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
};

/** supervision + AI extension rows are small — every list shape fetches them in full */
const fetchSupervisionAndAi = async () => {
  const supRows = await db.query.employeeSupervisors.findMany({
    columns: { employeeId: true, supervisorId: true },
    orderBy: { employeeId: 'asc' },
  });
  const aiRows = await db.query.aiEmployees.findMany({
    columns: {
      userId: true,
      environmentId: true,
      executable: true,
      providerId: true,
      model: true,
      apiKeySecretId: true,
      instructions: true,
    },
    orderBy: { userId: 'asc' },
  });
  return { supRows, aiRows };
};

const listEmployeesSnapshot = async () => {
  const rows = await db.query.user.findMany({
    columns: { id: true, name: true, email: true, image: true, title: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const { supRows, aiRows } = await fetchSupervisionAndAi();
  return mapEmployeeRows(rows, supRows, aiRows);
};

/** paged + searched variant of the snapshot; total counts users only */
const listEmployeesPaged = async (input: { page: number; pageSize: number; q?: string }) => {
  const q = input.q?.trim();
  const { data, total } = await db.query.user.findManyAndCount({
    columns: { id: true, name: true, email: true, image: true, title: true, createdAt: true, updatedAt: true },
    where: q
      ? {
          OR: [
            { name: { ilike: `%${escapeIlike(q)}%` } },
            { email: { ilike: `%${escapeIlike(q)}%` } },
            { title: { ilike: `%${escapeIlike(q)}%` } },
          ],
        }
      : EmptyFilter,
    orderBy: { createdAt: 'asc' },
    limit: input.pageSize,
    offset: (input.page - 1) * input.pageSize,
  });
  const { supRows, aiRows } = await fetchSupervisionAndAi();
  return { employees: mapEmployeeRows(data, supRows, aiRows), total };
};

export const employeesRouter = os.router({
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listEmployeesSnapshot()),

  /** paged + searched rows for the employees manager table */
  listPaged: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        q: z.string().trim().optional(),
      }),
    )
    .handler(({ input }) => listEmployeesPaged(input)),

  live: protectedProcedure.handler(({ context }) =>
    liveGenerator([CHANGE_RESOURCE.EMPLOYEES], listEmployeesSnapshot, context),
  ),

  /** create an employee AND its login user. kind=ai also mints an API key
   *  (returned once) and the AI extension row. */
  create: adminProcedure
    .input(
      z.strictObject({
        name: z.string().min(1).max(100),
        email: z.email(),
        kind: z.enum(['human', 'ai']),
        image: avatarImageSchema,
        title: z.string().min(1).max(EMPLOYEE_TITLE_MAX),
        supervisorIds: z.array(z.string().min(1)).max(20).default([]),
        environmentId: z.string().min(1).optional(),
        instructions: z.string().max(10_000).optional(),
        executable: z
          .string()
          .min(1)
          .max(120)
          .regex(ACP_EXECUTABLE_RE, 'ACP executable must be shell-safe command words, e.g. "hermes acp"')
          .optional(),
        providerId: z.string().min(1).nullable().optional(),
        model: z.string().min(1).max(200).nullable().optional(),
        apiKeySecretId: z.string().min(1).nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      // supervisor ids are uuid refs: shape + canonical form before ANY gate or
      // lookup, so a malformed id is decided here (default fills [])
      const supervisorIds = normalizeSupervisorIds(input.supervisorIds ?? []);
      // AI employees REQUIRE an environment
      if (input.kind === 'ai' && !input.environmentId) {
        throw new ORPCError('BAD_REQUEST', { message: 'AI employees need an environment' });
      }
      if (
        input.kind === 'human' &&
        (input.environmentId !== undefined || input.instructions !== undefined || input.executable !== undefined)
      ) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'environment/instructions/acp executable apply to AI employees only',
        });
      }
      // supervisors must exist and not include a duplicate
      assertNoDuplicateSupervisors(supervisorIds);
      await assertSupervisorsExist(supervisorIds);
      // environment must exist for AI
      if (input.environmentId) await assertEnvironmentExists(input.environmentId);
      // email must be free
      await assertEmailAvailable(input.email);
      // user IS the employee: one row carries identity + employment.
      // AI-ness = extension row, never a column.
      const userId = uuidv7();
      await db.insert(userTable).values({
        id: userId,
        name: input.name,
        email: input.email,
        role: ROLE.EMPLOYEE,
        title: input.title,
        ...(input.image !== undefined && input.image !== null ? { image: input.image } : {}),
      });
      if (supervisorIds.length > 0) {
        await db.insert(supervisorsTable).values(supervisorIds.map((s) => ({ employeeId: userId, supervisorId: s })));
      }
      let apiKey: string | undefined;
      if (input.kind === 'ai') {
        if (input.apiKeySecretId) await assertSecretExists(input.apiKeySecretId);
        if (input.providerId) await assertProviderExists(input.providerId);
        await db.insert(aiEmployeesTable).values({
          userId,
          environmentId: nonNull(input.environmentId),
          instructions: input.instructions ?? '',
          executable: requiredExecutable(input.executable),
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          apiKeySecretId: input.apiKeySecretId ?? null,
        });
      }
      // every new employee — AI or human — gets an initial access key (shown once)
      apiKey = (await mintAccessKey(derivedAccessKeyName(input.name, ' access key'), userId)).key;
      await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.CREATE);
      // a runtime-minted AI agent needs its per-agent worker NOW: workers sync on
      // boot + settings.update only, so a create without this resync left every
      // dispatch of the new agent queued forever (run row stuck RUNNING, #177)
      if (input.kind === 'ai') {
        const { onDispatcherSettingsChanged } = await import('../tasks/dispatcher.service');
        await onDispatcherSettingsChanged();
      }
      return { id: userId, userId, apiKey };
    }),

  update: adminProcedure
    .input(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1).max(100),
        email: z.email().optional(),
        title: z.string().min(1).max(EMPLOYEE_TITLE_MAX),
        supervisorIds: z.array(z.string().min(1)).max(20),
        environmentId: z.string().min(1).nullable().optional(),
        instructions: z.string().max(10_000).nullable().optional(),
        executable: z
          .string()
          .min(1)
          .max(120)
          .regex(ACP_EXECUTABLE_RE, 'ACP executable must be shell-safe command words, e.g. "hermes acp"')
          .nullable()
          .optional(),
        providerId: z.string().min(1).nullable().optional(),
        model: z.string().min(1).max(200).nullable().optional(),
        apiKeySecretId: z.string().min(1).nullable().optional(),
        /** avatar: data URL (resized client-side); null clears */
        image: avatarImageSchema,
      }),
    )
    .handler(async ({ input }) => {
      requireUuid(input.id, 'BAD_REQUEST', 'invalid employee id');
      // supervisor ids are uuid refs: shape + canonical form before ANY lookup,
      // so a malformed id is decided here, never after the target query
      const supervisorIds = normalizeSupervisorIds(input.supervisorIds);
      const rows = await db.query.user.findMany({
        columns: { email: true },
        where: { id: { eq: input.id } },
        orderBy: { id: 'asc' },
      });
      const emp = rows[0];
      if (!emp) {
        throw new ORPCError('NOT_FOUND', { message: 'employee not found' });
      }
      const aiRow = (
        await db.query.aiEmployees.findMany({
          columns: { userId: true },
          where: { userId: { eq: input.id } },
          orderBy: { userId: 'asc' },
        })
      )[0];
      assertNoDuplicateSupervisors(supervisorIds);
      if (supervisorIds.includes(input.id.toLowerCase())) {
        throw new ORPCError('BAD_REQUEST', { message: 'an employee cannot supervise themselves' });
      }
      // supervisors must exist; cycle check over the supervision graph
      await assertSupervisorsExist(supervisorIds);
      await assertAcyclicSupervision(input.id.toLowerCase(), supervisorIds);
      // ---- validate everything else BEFORE the first write ----
      if (input.email !== undefined && input.email !== emp.email) {
        await assertEmailAvailable(input.email);
      }
      // AI fields — only when this employee IS an AI (extension row exists)
      const aiPatch = aiRow && hasAiExtensionField(input) ? await aiExtensionPatch(input) : null;
      // ---- commit: ai extension + user row + supervisor graph land together ----
      await db.transaction(async (tx) => {
        if (aiPatch && aiRow) {
          await tx.update(aiEmployeesTable).set(aiPatch).where(eq(aiEmployeesTable.userId, aiRow.userId));
        }
        await tx
          .update(userTable)
          .set({
            name: input.name,
            title: input.title,
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.image !== undefined ? { image: input.image } : {}),
            updatedAt: new Date(),
          })
          .where(eq(userTable.id, input.id));
        await tx.delete(supervisorsTable).where(eq(supervisorsTable.employeeId, input.id));
        if (supervisorIds.length > 0) {
          await tx
            .insert(supervisorsTable)
            .values(supervisorIds.map((s) => ({ employeeId: input.id, supervisorId: s })));
        }
      });
      await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.UPDATE);
      return { ok: true };
    }),

  titles: {
    list: protectedProcedure.handler(async () => {
      const rows = await db.query.employeeTitles.findMany({
        columns: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const counts = await db
        .select({ title: userTable.title, count: count() })
        .from(userTable)
        .groupBy(userTable.title);
      const byTitle = new Map(counts.map((c) => [c.title, Number(c.count)]));
      return { titles: rows.map((t) => ({ id: t.id, name: t.name, employees: byTitle.get(t.name) ?? 0 })) };
    }),

    live: protectedProcedure.handler(({ context }) =>
      liveGenerator(
        [CHANGE_RESOURCE.EMPLOYEES],
        async () => {
          const rows = await db.query.employeeTitles.findMany({
            columns: { id: true, name: true },
            orderBy: { name: 'asc' },
          });
          const counts = await db
            .select({ title: userTable.title, count: count() })
            .from(userTable)
            .groupBy(userTable.title);
          const byTitle = new Map(counts.map((c) => [c.title, Number(c.count)]));
          return { titles: rows.map((t) => ({ id: t.id, name: t.name, employees: byTitle.get(t.name) ?? 0 })) };
        },
        context,
      ),
    ),

    // admin-tier: the rename cascades onto every employee holding the old
    // title — same tier as statuses.save / titles.remove (SPEC write tiers)
    save: adminProcedure
      .input(
        z.strictObject({
          id: z.string().min(1).optional(),
          name: z.string().min(1).max(EMPLOYEE_TITLE_MAX),
        }),
      )
      .handler(async ({ input }) => {
        const id = input.id ?? uuidv7();
        // one transaction: the employee cascade and the catalog rename land together,
        // and the name clash is checked inside it (a UNIQUE trip must roll back the
        // cascade instead of leaving employees renamed under the old catalog entry)
        await db.transaction(async (tx) => {
          const clash = await tx
            .select({ id: employeeTitlesTable.id })
            .from(employeeTitlesTable)
            .where(and(eq(employeeTitlesTable.name, input.name), ne(employeeTitlesTable.id, id)));
          if (clash.length > 0)
            throw new ORPCError('BAD_REQUEST', { message: 'a title with that name already exists' });
          if (input.id === undefined) {
            await tx.insert(employeeTitlesTable).values({ id, name: input.name });
            return;
          }
          const existing = (
            await tx
              .select({ name: employeeTitlesTable.name })
              .from(employeeTitlesTable)
              .where(eq(employeeTitlesTable.id, id))
          )[0];
          if (!existing) throw new ORPCError('NOT_FOUND', { message: 'title not found' });
          // rename cascades to employees holding the old title (free-text column, no FK)
          await tx
            .update(userTable)
            .set({ title: input.name, updatedAt: new Date() })
            .where(eq(userTable.title, existing.name));
          await tx
            .update(employeeTitlesTable)
            .set({ name: input.name, updatedAt: new Date() })
            .where(eq(employeeTitlesTable.id, id));
        });
        await publishChange(
          CHANGE_RESOURCE.EMPLOYEES,
          input.id === undefined ? CHANGE_ACTION.CREATE : CHANGE_ACTION.UPDATE,
        );
        return { id };
      }),

    /** removing a catalog entry leaves employees' free-text titles untouched */
    remove: adminProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input }) => {
      const deleted = await db
        .delete(employeeTitlesTable)
        .where(eq(employeeTitlesTable.id, input.id))
        .returning({ id: employeeTitlesTable.id });
      if (deleted.length === 0) throw new ORPCError('NOT_FOUND', { message: 'title not found' });
      await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.REMOVE);
      return { ok: true };
    }),
  },

  remove: adminProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input, context }) => {
    requireUuid(input.id, 'BAD_REQUEST', 'invalid employee id');
    // guard: cannot delete yourself (session may be absent in raw handler tests)
    const selfId = (context as { session?: { user?: { id?: string } } }).session?.user?.id;
    if (selfId && selfId.toLowerCase() === input.id.toLowerCase()) {
      throw new ORPCError('BAD_REQUEST', { message: 'you cannot delete your own account' });
    }
    // guard: cannot delete the last admin (workspace lockout)
    const target = await db.query.user.findFirst({
      columns: { id: true, role: true, name: true },
      where: { id: { eq: input.id } },
    });
    if (!target) {
      throw new ORPCError('NOT_FOUND', { message: 'employee not found' });
    }
    if (target.role === ROLE.ADMIN) {
      const admins = await db.query.user.findMany({
        columns: { id: true },
        where: { role: { eq: ROLE.ADMIN } },
        orderBy: { id: 'asc' },
      });
      if (admins.length <= 1) {
        throw new ORPCError('BAD_REQUEST', { message: 'cannot delete the last admin' });
      }
    }
    // guard: vault_secrets.created_by cascades on user delete, so any secret this
    // employee still owns (and anything linking it) would vanish with them
    const ownedSecrets = await db
      .select({ id: vaultSecretsTable.id })
      .from(vaultSecretsTable)
      .where(eq(vaultSecretsTable.createdBy, input.id));
    if (ownedSecrets.length > 0) {
      const ownedIds = ownedSecrets.map((s) => s.id);
      const envLinks = await db
        .select({ id: environmentsTable.id })
        .from(environmentsTable)
        .where(inArray(environmentsTable.secretId, ownedIds))
        .limit(1);
      const aiLinks = await db
        .select({ userId: aiEmployeesTable.userId })
        .from(aiEmployeesTable)
        .where(inArray(aiEmployeesTable.apiKeySecretId, ownedIds))
        .limit(1);
      const blockers = [`${ownedSecrets.length} vault secret(s) owned`];
      if (envLinks.length > 0) blockers.push('environments');
      if (aiLinks.length > 0) blockers.push('AI employees');
      throw new ORPCError('BAD_REQUEST', {
        message: `employee is in use by ${blockers.join(', ')} — reassign or delete those first`,
      });
    }
    // REVIEW LAW (#365) + ANSWER-ROLE REMOVAL (#369): an employee removed mid-round
    // or mid-question must never wedge a task. Capture first (read-only): their
    // pending review rows, their own pending approval obligations and their pending
    // ANSWER obligations. After the delete lands (the FK nulls reviewer_id /
    // employee_id, leaving the void rows the settle keys on) the captured approval
    // obligations are DROPPED (not cancelled — a cancelled row reads as a dead round
    // to the approver tally), the ANSWER obligations are cancelled by id, rows are
    // noted, every affected round left with no live reviewer settles by the normal
    // matrix, and every waiting-answer task left with no holder returns to its flow
    // instead of waiting on an answer that can never arrive.
    const { prepareReviewerRemoval, settleReviewerRemovalRounds } = await import('../tasks/review.service');
    const reviewRemoval = await prepareReviewerRemoval(input.id);
    // EMPLOYEE REMOVAL (#370): an in-flight turn of the departing employee has no
    // owner after the delete — capture its RUNNING runs read-only now and settle
    // them STOPPED after the delete commits (the in-flight turn then skips every
    // settle side effect: no park, no bounce, no message rewrite).
    const { runningRunIdsForEmployee, stopRunsForRemoval } = await import('../tasks/runner.service');
    const removalRunIds = await runningRunIdsForEmployee(input.id);
    // deleting the user cascades supervisors, ai extension, api keys
    // (existence already verified above — no race window worth a second check)
    // UNBIND = REVOKE (SPEC MCP): the cascade removes the employee's bindings
    // + token rows — revoke the provider grants best-effort BEFORE the delete
    const { revokeOauthTokensForEmployee } = await import('../mcp/mcp-oauth.service');
    await revokeOauthTokensForEmployee(input.id);
    await db.delete(userTable).where(eq(userTable.id, input.id));
    await stopRunsForRemoval(removalRunIds);
    await settleReviewerRemovalRounds(reviewRemoval, target.name);
    await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.DELETE);
    // the per-agent worker roster follows the AI roster — a removed agent's
    // worker closes on the same resync (cheap no-op for human deletes, #177)
    const { onDispatcherSettingsChanged } = await import('../tasks/dispatcher.service');
    await onDispatcherSettingsChanged();
    return { ok: true };
  }),

  /** mint a fresh access key for any employee — AI or human (old keys stay valid) */
  createApiKey: adminProcedure
    .input(
      z.strictObject({
        employeeId: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .handler(async ({ input }) => {
      requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      const rows = await db.query.user.findMany({
        columns: { id: true, name: true },
        where: { id: { eq: input.employeeId } },
        orderBy: { id: 'asc' },
      });
      const emp = rows[0];
      if (!emp) throw new ORPCError('NOT_FOUND', { message: 'employee not found' });
      const created = await mintAccessKey(
        input.name?.trim() ? assertAccessKeyName(input.name) : derivedAccessKeyName(emp.name, ' key'),
        emp.id,
      );
      return { key: created.key, id: created.id };
    }),

  /** rename an access key — employeeId scopes the write to that employee's keys */
  updateApiKey: adminProcedure
    .input(
      z.strictObject({
        keyId: z.string().min(1),
        /** owner scope: a key that belongs to another employee reads as NOT_FOUND */
        employeeId: z.string().min(1).optional(),
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ input }) => {
      requireUuid(input.keyId, 'BAD_REQUEST', 'invalid api key id');
      if (input.employeeId !== undefined) requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      const name = assertAccessKeyName(input.name);
      if (!name) throw new ORPCError('BAD_REQUEST', { message: 'name is required' });
      const updated = await db
        .update(apikeyTable)
        .set({ name })
        .where(
          input.employeeId
            ? and(eq(apikeyTable.id, input.keyId), eq(apikeyTable.referenceId, input.employeeId))
            : eq(apikeyTable.id, input.keyId),
        )
        .returning({ id: apikeyTable.id });
      if (updated.length === 0) throw new ORPCError('NOT_FOUND', { message: 'api key not found' });
      await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.UPDATE);
      return { ok: true };
    }),

  /** list an employee's API keys (never the key value) — SELF-OR-ADMIN read
   *  (SPEC "Roles & access", CREDENTIAL-METADATA SCOPE): key metadata is not
   *  roster data, so an EMPLOYEE/VIEWER session reads only its OWN keys. Any
   *  other employee id — like a malformed uuid, which a uuid column cannot even
   *  compare — is the same NOT_FOUND miss, never a 500 and never a peek. */
  listApiKeys: protectedProcedure
    // blank is accepted at the schema edge and owned by the miss path (UUID-FILTER LAW)
    .input(z.strictObject({ employeeId: z.string() }))
    .handler(async ({ input, context }): Promise<ApiKeyRow[]> => {
      const selfId = context.session.user.id;
      const isAdmin = context.session.user.role === ROLE.ADMIN;
      // uuid comparison is case-insensitive in Postgres — the scope check must be too
      if (!isUuid(input.employeeId) || (!isAdmin && input.employeeId.toLowerCase() !== selfId.toLowerCase())) {
        throw new ORPCError('NOT_FOUND', { message: 'employee not found' });
      }
      const rows = await db.query.user.findMany({
        columns: { id: true },
        where: { id: { eq: input.employeeId } },
        orderBy: { id: 'asc' },
      });
      const emp = rows[0];
      if (!emp) throw new ORPCError('NOT_FOUND', { message: 'employee not found' });
      const keys = await db
        .select()
        .from(apikeyTable)
        .where(eq(apikeyTable.referenceId, emp.id))
        .orderBy(desc(apikeyTable.createdAt));
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        start: k.start,
        prefix: k.prefix,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        createdAt: k.createdAt.toISOString(),
      }));
    }),

  /** revoke one API key — employeeId scopes the delete to that employee's keys */
  revokeApiKey: adminProcedure
    .input(
      z.strictObject({
        keyId: z.string().min(1),
        /** owner scope: a key that belongs to another employee reads as NOT_FOUND */
        employeeId: z.string().min(1).optional(),
      }),
    )
    .handler(async ({ input }) => {
      requireUuid(input.keyId, 'BAD_REQUEST', 'invalid api key id');
      if (input.employeeId !== undefined) requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      const deleted = await db
        .delete(apikeyTable)
        .where(
          input.employeeId
            ? and(eq(apikeyTable.id, input.keyId), eq(apikeyTable.referenceId, input.employeeId))
            : eq(apikeyTable.id, input.keyId),
        )
        .returning({ id: apikeyTable.id });
      if (deleted.length === 0) {
        throw new ORPCError('NOT_FOUND', { message: 'api key not found' });
      }
      await publishChange(CHANGE_RESOURCE.EMPLOYEES, CHANGE_ACTION.UPDATE);
      return { ok: true };
    }),
});
