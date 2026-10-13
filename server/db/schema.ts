// Drizzle rc (Relations v2) over Postgres.
import { pgTable, text, timestamp, boolean, integer, index, primaryKey, check, jsonb, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { defineRelations } from 'drizzle-orm'

// Auth tables (tandem_user/session/account/verification/apikey) are GENERATED
// by the better-auth CLI into ./schema.auth.ts — regenerate with `bun run
// gen:auth`; never edit by hand. CI reruns the generator and fails on drift.
// Domain tables below are hand-owned.
import { user, session, account, verification, apikey } from './schema.auth'
export * from './schema.auth'

// ---------- Tandem domain tables (hand-owned) ----------

// SSH targets that run the Hermes agent (M2).
export const environments = pgTable('tandem_environments', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: text('port').notNull().default('22'),
  username: text('username').notNull(),
  // optional vault secret used for SSH auth by probe + runner
  secretId: text('secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  // how the linked secret is used: as an SSH identity file or as a password
  secretUsage: text('secret_usage').notNull().default('ssh-key'),
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
// Vault folders: pure metadata for categorizing secrets. Deleting a folder
// never deletes secrets (FK SET NULL -> uncategorized).
export const vaultFolders = pgTable('tandem_vault_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Employee title catalog: offered in the employee form picker. Employees keep
// title as free text (no FK); renaming a catalog entry rewrites matching
// employees so the org chart stays consistent.
export const employeeTitles = pgTable('tandem_employee_titles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const vaultSecrets = pgTable('tandem_vault_secrets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  folderId: text('folder_id').references(() => vaultFolders.id, { onDelete: 'set null' }),
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

// Model providers: curated catalog of OpenAI/Anthropic-compatible endpoints.
// API keys are NEVER stored here — per-agent in the vault (fleet law).
export const modelProviders = pgTable('tandem_model_providers', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  /** set of API styles this endpoint speaks (see shared/api-styles.ts) */
  endpoints: jsonb('endpoints').notNull().default(sql`'["OPENAI-COMPLETIONS"]'::jsonb`),
  extraHeaders: text('extra_headers'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// AI extension (1:1 with user): row existence marks the employee as an AI
// agent; absence = human employee. No kind column anywhere.
export const aiEmployees = pgTable('tandem_ai_employees', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').notNull().references(() => environments.id, { onDelete: 'restrict' }),
  instructions: text('instructions').notNull().default(''),
  // agent harness: 'hermes' (only one today; more later)
  harness: text('harness').notNull().default('hermes'),
  // executable name used on the environment when dispatching (default 'hermes')
  executable: text('executable').notNull().default('hermes'),
  // model access: provider registry id + freetext model name + vault-held API key
  providerId: text('provider_id').references(() => modelProviders.id, { onDelete: 'set null' }),
  model: text('model'),
  apiKeySecretId: text('api_key_secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Tasks: work items assigned to employees (human or AI). AI assignees get
// dispatched to their environment by the runner (M5).
export const projects = pgTable('tandem_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // active | archived
  status: text('status').notNull().default('active'),
  // nesting: parent project (self-reference); deleting a parent orphans children to root
  parentId: text('parent_id').references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tandem_projects_parent_idx').on(t.parentId),
])


// Custom task statuses — workspace-defined workflow states with allowed
// transitions (nextIds). Seeded with todo/doing/done; tasks keep a text
// status referencing taskStatuses.id (no hard FK: deleting a status moves
// its tasks back to the first status).
export const taskStatuses = pgTable('tandem_task_statuses', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** tailwind badge color: neutral | primary | success | warning | error | info */
  color: text('color').notNull().default('neutral'),
  /** 0-based board column order */
  position: integer('position').notNull().default(0),
  /** workflow meaning — drives dispatch: backlog|ready|working|paused|done|cancelled */
  category: text('category').notNull().default('backlog'),
  /** allowed transitions: array of status ids */
  nextIds: text('next_ids').array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tasks = pgTable('tandem_tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  // references tandem_task_statuses.id (seeded: todo/doing/done)
  status: text('status').notNull().default('todo'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  assigneeId: text('assignee_id').references(() => user.id, { onDelete: 'set null' }),
  /** the person responsible for routing questions/answers (creator by default; NOT necessarily a supervisor) */
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
  /** unanimous-approval gate before done; any mix of AI/human */
  reviewers: text('reviewers').array().notNull().default(sql`'{}'::text[]`),
  /** who currently owes the answer while status = waiting_answer (moves on forward) */
  questionHolderId: text('question_holder_id').references(() => user.id, { onDelete: 'set null' }),
  /** everyone the question has already been through: [owner, ...forwards] — loop guard */
  questionChain: text('question_chain').array().notNull().default(sql`'{}'::text[]`),
  /** reviewers who approved the current review round; reset on request-changes */
  reviewApprovals: text('review_approvals').array().notNull().default(sql`'{}'::text[]`),
  /** earliest time the dispatcher may claim this task again (failure backoff); null = now */
  dispatchAfter: timestamp('dispatch_after', { withTimezone: true }),
  /** consecutive failed runs; drives the backoff ladder and resets on success */
  failStreak: integer('fail_streak').notNull().default(0),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tandem_tasks_assignee_idx').on(t.assigneeId),
  index('tandem_tasks_project_idx').on(t.projectId),
  index('tandem_tasks_status_idx').on(t.status),
])

// One row per agent dispatch over SSH. Output is the capped tail.
export const taskRuns = pgTable('tandem_task_runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  employeeId: text('employee_id').references(() => user.id, { onDelete: 'set null' }),
  environmentId: text('environment_id'),
  /** running | done | failed */
  status: text('status').notNull().default('running'),
  exitCode: integer('exit_code'),
  output: text('output').notNull().default(''),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  index('tandem_task_runs_task_idx').on(t.taskId, t.startedAt),
])

// Task activity feed: questions, answers, forwards, verdicts, status notes.
export const taskActivity = pgTable('tandem_task_activity', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  /** question | answer | forward | note | verdict | status */
  kind: text('kind').notNull(),
  authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
  body: text('body').notNull().default(''),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tandem_task_activity_task_idx').on(t.taskId, t.createdAt),
])

// ---------- relations ----------

export const relations = defineRelations(
  { user, session, account, verification, settings, environments, employeeSupervisors, aiEmployees, apikey, vaultSecrets, vaultAudit, vaultFolders, employeeTitles, tasks, taskActivity, taskRuns, taskStatuses, modelProviders, projects },
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
