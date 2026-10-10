// Drizzle rc (Relations v2) over Postgres.
// Auth tables (tandem_user/session/account/verification/apikey) are GENERATED
// by the better-auth CLI — regenerate with `bun run gen:auth`; never edit by
// hand. Domain tables below are hand-owned.
import { pgTable, text, timestamp, boolean, integer, index, primaryKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { defineRelations } from 'drizzle-orm'

// >>> BEGIN GENERATED better-auth tables (bun run gen:auth) — do not edit by hand
export const user = pgTable('tandem_user', {
  id: text('id').primaryKey(),
name: text('name').notNull(),
 email: text('email').notNull().unique(),
 emailVerified: boolean('email_verified').default(false).notNull(),
 image: text('image'),
 createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => /* @__PURE__ */ new Date()).notNull(),
 role: text('role', { enum: ['admin', 'employee', 'viewer'] }).default('viewer'),
 title: text('title').default(''),
})

export const session = pgTable('tandem_session', {
  id: text('id').primaryKey(),
expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
 token: text('token').notNull().unique(),
 createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
 ipAddress: text('ip_address'),
 userAgent: text('user_agent'),
 userId: text('user_id').notNull().references(()=> user.id, { onDelete: 'cascade' }),
}, (t) => [
  index('session_userId_idx').on(t.userId),
])

export const account = pgTable('tandem_account', {
  id: text('id').primaryKey(),
accountId: text('account_id').notNull(),
 providerId: text('provider_id').notNull(),
 userId: text('user_id').notNull().references(()=> user.id, { onDelete: 'cascade' }),
 accessToken: text('access_token'),
 refreshToken: text('refresh_token'),
 idToken: text('id_token'),
 accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
 refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
 scope: text('scope'),
 password: text('password'),
 createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (t) => [
  index('account_userId_idx').on(t.userId),
])

export const verification = pgTable('tandem_verification', {
  id: text('id').primaryKey(),
identifier: text('identifier').notNull(),
 value: text('value').notNull(),
 expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
 createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => /* @__PURE__ */ new Date()).notNull(),
}, (t) => [
  index('verification_identifier_idx').on(t.identifier),
])

export const apikey = pgTable('tandem_apikey', {
  id: text('id').primaryKey(),
configId: text('config_id').default('default').notNull(),
 name: text('name'),
 start: text('start'),
 referenceId: text('reference_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
 prefix: text('prefix'),
 key: text('key').notNull(),
 refillInterval: integer('refill_interval'),
 refillAmount: integer('refill_amount'),
 lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
 enabled: boolean('enabled').default(true),
 rateLimitEnabled: boolean('rate_limit_enabled').default(true),
 rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
 rateLimitMax: integer('rate_limit_max').default(10),
 requestCount: integer('request_count').default(0),
 remaining: integer('remaining'),
 lastRequest: timestamp('last_request', { withTimezone: true }),
 expiresAt: timestamp('expires_at', { withTimezone: true }),
 createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
 permissions: text('permissions'),
 metadata: text('metadata'),
}, (t) => [
  index('apikey_configId_idx').on(t.configId),
  index('apikey_referenceId_idx').on(t.referenceId),
  index('apikey_key_idx').on(t.key),
])

// <<< END GENERATED better-auth tables

// ---------- Tandem domain tables (hand-owned) ----------

// SSH targets that run the Hermes agent (M2).
export const environments = pgTable('tandem_environments', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: text('port').notNull().default('22'),
  username: text('username').notNull(),
  // optional vault secret (kind=ssh-key) used for SSH auth by probe + runner
  secretId: text('secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// runtime key/value settings (oidc providers JSON, flags, …)
export const settings = pgTable('tandem_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Secret vault: AES-256-GCM encrypted values. Secrets are write-only from the
// API — plaintext never leaves the server after create; only server-side
// consumers (M5 SSH runner) import vault-crypto and decrypt.
export const vaultSecrets = pgTable('tandem_vault_secrets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ciphertext: text('ciphertext').notNull(), // v1:<b64 iv>:<b64 tag>:<b64 ct>
  lastFour: text('last_four').notNull().default(''), // display hint only
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Audit trail: every vault write and every server-side decrypt ("use").
export const vaultAudit = pgTable('tandem_vault_audit', {
  id: text('id').primaryKey(),
  secretId: text('secret_id').references(() => vaultSecrets.id, { onDelete: 'cascade' }),
  secretName: text('secret_name').notNull(),
  action: text('action').notNull(), // create | update | delete | use
  actorId: text('actor_id').notNull().default('system'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tandem_vault_audit_secret_idx').on(t.secretId),
  index('tandem_vault_audit_at_idx').on(t.at),
])

// Supervision is many-to-many: one employee may have many supervisors.
// Users ARE employees, so both columns reference tandem_user.
// Self-supervision is structurally impossible (CHECK).
export const employeeSupervisors = pgTable('tandem_employee_supervisors', {
  employeeId: text('employee_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  supervisorId: text('supervisor_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.employeeId, t.supervisorId] }),
  check('no_self_supervision', sql`${t.supervisorId} <> ${t.employeeId}`),
  index('tandem_employee_supervisors_supervisor_idx').on(t.supervisorId),
])

// AI extension (1:1 with user): row existence marks the employee as an AI
// agent; absence = human employee. No kind column anywhere.
export const aiEmployees = pgTable('tandem_ai_employees', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'restrict' }),
  instructions: text('instructions').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------- relations ----------

export const relations = defineRelations(
  { user, session, account, verification, settings, environments, employeeSupervisors, aiEmployees, apikey, vaultSecrets, vaultAudit },
  (helpers) => ({
    user: {
      sessions: helpers.many.session({ from: helpers.user.id, to: helpers.session.userId }),
      accounts: helpers.many.account({ from: helpers.user.id, to: helpers.account.userId }),
      supervisors: helpers.many.employeeSupervisors({ from: helpers.user.id, to: helpers.employeeSupervisors.employeeId }),
      ai: helpers.one.aiEmployees({ from: helpers.user.id, to: helpers.aiEmployees.userId }),
      apiKeys: helpers.many.apikey({ from: helpers.user.id, to: helpers.apikey.referenceId }),
      vaultSecrets: helpers.many.vaultSecrets({ from: helpers.user.id, to: helpers.vaultSecrets.createdBy }),
    },
    session: {
      user: helpers.one.user({ from: helpers.session.userId, to: helpers.user.id }),
    },
    account: {
      user: helpers.one.user({ from: helpers.account.userId, to: helpers.user.id }),
    },
    employeeSupervisors: {
      employees: helpers.one.user({ from: helpers.employeeSupervisors.employeeId, to: helpers.user.id }),
      supervisors: helpers.one.user({ from: helpers.employeeSupervisors.supervisorId, to: helpers.user.id }),
    },
    aiEmployees: {
      users: helpers.one.user({ from: helpers.aiEmployees.userId, to: helpers.user.id }),
      environments: helpers.one.environments({ from: helpers.aiEmployees.environmentId, to: helpers.environments.id }),
    },
    apikey: {
      users: helpers.one.user({ from: helpers.apikey.referenceId, to: helpers.user.id }),
    },
    environments: {},
    settings: {},
    vaultSecrets: {},
    vaultAudit: {},
    verification: {},
  }),
)

export const authSchema = {
  user,
  session,
  account,
  verification,
  apikey,
}
