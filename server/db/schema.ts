// Drizzle rc (Relations v2) over Postgres. Auth tables = better-auth canonical set.
// Domain tables: settings (key/value runtime config incl. OIDC providers).
import { pgEnum, pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { check, index, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { defineRelations } from 'drizzle-orm'

// ---------- better-auth canonical tables ----------

export const user = pgTable('tandem_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(true),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  role: text('role').notNull().default('viewer'),
})

export const session = pgTable('tandem_session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('tandem_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable('tandem_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

// ---------- Tandem tables ----------

// SSH targets that run the Hermes agent (M2). The runner (M5) will execute
// `ssh -p <port> <username>@<host> hermes chat …` against these.
export const environments = pgTable('tandem_environments', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: text('port').notNull().default('22'), // keep as text: leading-zero-free numeric string, validated by zod
  username: text('username').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// API keys (@better-auth/api-key). Keys are HASHED; referenceId -> user.id.
export const apikey = pgTable('tandem_apikey', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull().default('default'),
  name: text('name').notNull(),
  start: text('start'),
  prefix: text('prefix'),
  key: text('key').notNull(),
  referenceId: text('reference_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  refillInterval: text('refill_interval'),
  refillAmount: text('refill_amount'),
  lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(true),
  rateLimitEnabled: boolean('rate_limit_enabled'),
  rateLimitTimeWindow: text('rate_limit_time_window'),
  rateLimitMax: text('rate_limit_max'),
  requestCount: text('request_count'),
  remaining: text('remaining'),
  lastRequest: timestamp('last_request', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  permissions: text('permissions'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tandem_apikey_reference_id_idx').on(t.referenceId),
])

// runtime key/value settings (oidc providers JSON, flags, …)
export const settings = pgTable('tandem_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Employees (M3): every employee IS a tandem_user (they all log in).
// humans: password/OIDC login. ai: x-api-key login (API key owner = user).
export const employeeKind = pgEnum('tandem_employee_kind', ['human', 'ai'])

export const employees = pgTable('tandem_employees', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  kind: employeeKind('kind').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Supervision is many-to-many: one employee may have many supervisors.
// supervisor_id != employee_id enforced by CHECK — self-supervision is
// structurally impossible, not just application-checked.
export const employeeSupervisors = pgTable('tandem_employee_supervisors', {
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  supervisorId: text('supervisor_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.employeeId, t.supervisorId] }),
  check('no_self_supervision', sql`${t.supervisorId} <> ${t.employeeId}`),
  // reverse-pair index keeps duplicate (B supervises A + A supervises B) lookups
  // cheap; the cycle check itself walks the graph at write time
  index('tandem_employee_supervisors_supervisor_idx').on(t.supervisorId),
])

// AI extension (1:1 with employees where kind='ai'): environment + instructions.
export const aiEmployees = pgTable('tandem_ai_employees', {
  employeeId: text('employee_id').primaryKey().references(() => employees.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'restrict' }),
  instructions: text('instructions').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------- relations ----------

export const relations = defineRelations(
  { user, session, account, verification, settings, environments, employees, employeeSupervisors, aiEmployees, apikey },
  (helpers) => ({
    user: {
      sessions: helpers.many.session({ from: helpers.user.id, to: helpers.session.userId }),
      accounts: helpers.many.account({ from: helpers.user.id, to: helpers.account.userId }),
      employees: helpers.one.employees({ from: helpers.user.id, to: helpers.employees.userId }),
      apiKeys: helpers.many.apikey({ from: helpers.user.id, to: helpers.apikey.referenceId }),
    },
    employees: {
      users: helpers.one.user({ from: helpers.employees.userId, to: helpers.user.id }),
      supervisors: helpers.many.employeeSupervisors({ from: helpers.employees.id, to: helpers.employeeSupervisors.employeeId }),
      ai: helpers.one.aiEmployees({ from: helpers.employees.id, to: helpers.aiEmployees.employeeId }),
    },
    employeeSupervisors: {
      employees: helpers.one.employees({ from: helpers.employeeSupervisors.employeeId, to: helpers.employees.id }),
      supervisors: helpers.one.employees({ from: helpers.employeeSupervisors.supervisorId, to: helpers.employees.id }),
    },
    aiEmployees: {
      employees: helpers.one.employees({ from: helpers.aiEmployees.employeeId, to: helpers.employees.id }),
      environments: helpers.one.environments({ from: helpers.aiEmployees.environmentId, to: helpers.environments.id }),
    },
    apikey: {
      users: helpers.one.user({ from: helpers.apikey.referenceId, to: helpers.user.id }),
    },
    session: {
      user: helpers.one.user({ from: helpers.session.userId, to: helpers.user.id }),
    },
    account: {
      user: helpers.one.user({ from: helpers.account.userId, to: helpers.user.id }),
    },
  }),
)

export const authSchema = {
  user,
  session,
  account,
  verification,
}
