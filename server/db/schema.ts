import { sql } from 'drizzle-orm';
import { defineRelations } from 'drizzle-orm';
// Drizzle rc (Relations v2) over Postgres.
import {
  type AnyPgColumn,
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  check,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Auth tables (user/session/account/verification/apikey) are GENERATED
// by the better-auth CLI into ./schema.auth.ts — regenerate with `bun run
// gen:auth`; never edit by hand. CI reruns the generator and fails on drift.
// Domain tables below are hand-owned.
import { user, session, account, verification, apikey } from './schema.auth';
export * from './schema.auth';

// ---------- Tandem domain tables (hand-owned) ----------

// SSH targets that run the Hermes agent (M2).
export const environments = pgTable('environments', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull().unique(),
  host: text('host').notNull(),
  port: text('port').notNull().default('22'),
  username: text('username').notNull(),
  // optional vault secret used for SSH auth by probe + runner
  secretId: text('secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  // how the linked secret is used: as an SSH identity file or as a password
  secretUsage: text('secret_usage').notNull().default('SSH_KEY'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// runtime key/value settings (oidc providers JSON, flags, …)
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Secret vault: AES-256-GCM encrypted values. Secrets are write-only from the
// API — plaintext never leaves the server after create; only server-side
// consumers (M5 SSH runner) import secret-crypto and decrypt.
// Vault folders: pure metadata for categorizing secrets. Deleting a folder
// never deletes secrets (FK SET NULL -> uncategorized).
export const vaultFolders = pgTable('vault_folders', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Employee title catalog: offered in the employee form picker. Employees keep
// title as free text (no FK); renaming a catalog entry rewrites matching
// employees so the org chart stays consistent.
export const employeeTitles = pgTable('employee_titles', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

export const vaultSecrets = pgTable('vault_secrets', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  folderId: text('folder_id').references(() => vaultFolders.id, { onDelete: 'set null' }),
  ciphertext: text('ciphertext').notNull(), // v1:<b64 iv>:<b64 tag>:<b64 ct>
  lastFour: text('last_four').notNull().default(''), // display hint only
  createdBy: uuid('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Supervision is many-to-many: one employee may have many supervisors.
// Users ARE employees, so both columns reference user.
// Self-supervision is structurally impossible (CHECK).
export const employeeSupervisors = pgTable(
  'employee_supervisors',
  {
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    supervisorId: uuid('supervisor_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.employeeId, t.supervisorId] }),
    check('no_self_supervision', sql`${t.supervisorId} <> ${t.employeeId}`),
    index('employee_supervisors_supervisor_idx').on(t.supervisorId),
  ],
);

// Model providers: curated catalog of OpenAI/Anthropic-compatible endpoints.
// API keys are NEVER stored here — per-agent in the vault (fleet law).
export const modelProviders = pgTable('model_providers', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  /** set of API styles this endpoint speaks (see shared/api-styles.ts) */
  endpoints: jsonb('endpoints')
    .notNull()
    .default(sql`'["OPENAI-COMPLETIONS"]'::jsonb`),
  extraHeaders: text('extra_headers'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// AI extension (1:1 with user): row existence marks the employee as an AI
// agent; absence = human employee. No kind column anywhere.
export const aiEmployees = pgTable('ai_employees', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environments.id, { onDelete: 'restrict' }),
  instructions: text('instructions').notNull().default(''),
  // full command that starts an ACP server on stdio in the environment
  // (e.g. 'hermes acp'); required, no default, shell-word safe (validated in the router)
  executable: text('executable').notNull(),
  // model access: provider registry id + freetext model name + vault-held API key
  providerId: text('provider_id').references(() => modelProviders.id, { onDelete: 'set null' }),
  model: text('model'),
  apiKeySecretId: text('api_key_secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Tasks: work items assigned to employees (human or AI). AI assignees get
// dispatched to their environment by the runner (M5).
export const projects = pgTable(
  'projects',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('ACTIVE'),
    /** project prompt — added to every brief of this project's tasks (empty = omitted) */
    prompt: text('prompt').notNull().default(''),
    // nesting: parent project (self-reference); deleting a parent orphans children to root
    parentId: text('parent_id').references((): AnyPgColumn => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [index('projects_parent_idx').on(t.parentId)],
);

// Custom task statuses — workspace-defined workflow states with allowed
// transitions (nextIds). Seeded with todo/doing/done; tasks keep a text
// status referencing taskStatuses.id (no hard FK: deleting a status moves
// its tasks back to the first status).
export const taskStatuses = pgTable('task_statuses', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull(),
  /** tailwind badge color: neutral | primary | success | warning | error | info */
  color: text('color').notNull().default('neutral'),
  /** 0-based board column order */
  position: integer('position').notNull().default(0),
  /** workflow meaning — drives dispatch: backlog|ready|working|paused|done|cancelled */
  category: text('category').notNull().default('backlog'),
  /** allowed transitions: array of status ids */
  nextIds: text('next_ids')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

export const tasks = pgTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    // references task_statuses.id (seeded: todo/doing/done)
    status: text('status').notNull().default('01a14743-43f4-7053-a698-5b4ef36ed046'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    assigneeId: uuid('assignee_id').references(() => user.id, { onDelete: 'set null' }),
    /** the person responsible for routing questions/answers (creator by default; NOT necessarily a supervisor) */
    ownerId: uuid('owner_id').references(() => user.id, { onDelete: 'set null' }),
    /** unanimous-approval gate before done; any mix of AI/human */
    reviewers: text('reviewers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** everyone the question has already been through: [owner, ...forwards] — loop guard */
    questionChain: text('question_chain')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** earliest time the dispatcher may claim this task again (failure backoff); null = now */
    dispatchAfter: timestamp('dispatch_after', { withTimezone: true }),
    /** consecutive failed runs; drives the backoff ladder and resets on success */
    failStreak: integer('fail_streak').notNull().default(0),
    /** subtask nesting: this task is a child of parent_task_id (unlimited depth) */
    parentTaskId: text('parent_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),

    /** status to restore when the auto-block (open children) lifts; null = not auto-blocked */
    preBlockStatus: text('pre_block_status'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('tasks_assignee_idx').on(t.assigneeId),
    index('tasks_project_idx').on(t.projectId),
    index('tasks_status_idx').on(t.status),
  ],
);

// One row per agent dispatch over SSH. Output is the capped tail.
/** pending obligations: who owes what on a task — answers, approvals. Single source
 * for "who acts next" (the waiting-on-you inbox + badge). answer role moves on forward. */
export const taskObligations = pgTable(
  'task_obligations',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // SET NULL, not CASCADE: deleting an employee keeps the obligation trail on the task
    employeeId: uuid('employee_id').references(() => user.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('task_obligations_task_idx').on(t.taskId, t.role, t.status),
    index('task_obligations_employee_idx').on(t.employeeId, t.status),
  ],
);

/** append-only assignee history; the current assignee stays denormalized on the task */
export const taskAssignments = pgTable(
  'task_assignments',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').references(() => user.id, { onDelete: 'set null' }),
    reason: text('reason').notNull().default(''),
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('task_assignments_task_idx').on(t.taskId, t.startedAt)],
);

/** agent proposals from run envelopes ([SUBTASKS]/[REASSIGN]) awaiting confirmation */
export const taskProposals = pgTable(
  'task_proposals',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => taskRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('PROPOSED'),
    decisionNote: text('decision_note').notNull().default(''),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [index('task_proposals_task_idx').on(t.taskId, t.status)],
);

export const taskRuns = pgTable(
  'task_runs',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    /** the run's thread turn — the task is reached via the message (user design, 2026-10-26) */
    messageId: text('message_id')
      .notNull()
      .references(() => taskMessages.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id').references(() => user.id, { onDelete: 'set null' }),
    /** REVIEW LAW: the ACP session this run used — review turns by OTHER employees must
     * never resume the assignee's session (one session per task PER EMPLOYEE, not per task) */
    sessionId: text('session_id'),
    environmentId: text('environment_id'),
    status: text('status').notNull().default('RUNNING'),
    exitCode: integer('exit_code'),
    output: text('output').notNull().default(''),
    /** the exact brief (prompt) sent to the agent for this turn; null on pre-2.26 rows */
    prompt: text('prompt'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('task_runs_message_idx').on(t.messageId, t.startedAt),
    index('task_runs_employee_started_idx').on(t.employeeId, t.startedAt),
  ],
);

// REVIEW LAW (2026-10-16): one row per reviewer per review round — the single source
// of truth for who approved what. pending -> approved | change_requested | rejected;
// rejected is a HUMAN-only verdict and cancels the task.
export const taskReviews = pgTable(
  'task_reviews',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id').references(() => user.id, { onDelete: 'set null' }),
    /** 1, 2, … — increments on resubmission after change_requested */
    round: integer('round').notNull(),
    status: text('status').notNull().default('PENDING'),
    note: text('note'),
    /** human click | ai review turn */
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('task_reviews_task_idx').on(t.taskId, t.round),
    // one review row per reviewer per round — DB backstop for the reviewer dedupe
    uniqueIndex('task_reviews_round_reviewer_uniq').on(t.taskId, t.round, t.reviewerId),
  ],
);

// Task activity feed: questions, answers, forwards, verdicts, status notes.
export const taskAttachments = pgTable(
  'task_attachments',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** set for agent-produced files: the run that produced them */
    runId: text('run_id').references(() => taskRuns.id, { onDelete: 'cascade' }),
    /** input (human upload) | output (collected from the sandbox) */
    kind: text('kind').notNull().default('input'),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [index('task_attachments_task_idx').on(t.taskId, t.createdAt)],
);

export const taskActivity = pgTable(
  'task_activity',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** question | answer | forward | note | verdict | status */
    kind: text('kind').notNull(),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull().default(''),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [index('task_activity_task_idx').on(t.taskId, t.createdAt)],
);

// Task conversation: one ordered thread per task. Base rows carry the rendered
// line; per-kind extension tables (1:1) hold the structured payload — the kind
// is whichever extension exists, no kind column (user design, 2026-10-24).
export const taskMessages = pgTable(
  'task_messages',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
  },
  (t) => [index('task_messages_task_idx').on(t.taskId, t.createdAt)],
);

export const taskMessageActivities = pgTable('task_message_activities', {
  messageId: text('message_id')
    .primaryKey()
    .references(() => taskMessages.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull().default({}),
});

// ---------- relations ----------

export const relations = defineRelations(
  {
    user,
    session,
    account,
    verification,
    settings,
    environments,
    employeeSupervisors,
    aiEmployees,
    apikey,
    vaultSecrets,
    vaultFolders,
    employeeTitles,
    tasks,
    taskActivity,
    taskRuns,
    taskMessages,
    taskMessageActivities,
    taskReviews,
    taskStatuses,
    modelProviders,
    projects,
    taskProposals,
    taskAttachments,
  },
  (helpers) => ({
    user: {
      sessions: helpers.many.session({ from: helpers.user.id, to: helpers.session.userId }),
      accounts: helpers.many.account({ from: helpers.user.id, to: helpers.account.userId }),
      supervisors: helpers.many.employeeSupervisors({
        from: helpers.user.id,
        to: helpers.employeeSupervisors.employeeId,
      }),
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
    vaultSecrets: {
      folder: helpers.one.vaultFolders({
        from: helpers.vaultSecrets.folderId,
        to: helpers.vaultFolders.id,
      }),
    },
    vaultFolders: {
      secrets: helpers.many.vaultSecrets({
        from: helpers.vaultFolders.id,
        to: helpers.vaultSecrets.folderId,
      }),
    },
    taskMessages: {
      task: helpers.one.tasks({ from: helpers.taskMessages.taskId, to: helpers.tasks.id }),
      author: helpers.one.user({ from: helpers.taskMessages.authorId, to: helpers.user.id }),
      run: helpers.one.taskRuns({ from: helpers.taskMessages.id, to: helpers.taskRuns.messageId }),
      activityExt: helpers.one.taskMessageActivities({
        from: helpers.taskMessages.id,
        to: helpers.taskMessageActivities.messageId,
      }),
    },
    taskMessageActivities: {
      message: helpers.one.taskMessages({
        from: helpers.taskMessageActivities.messageId,
        to: helpers.taskMessages.id,
      }),
    },
    taskRuns: {
      message: helpers.one.taskMessages({ from: helpers.taskRuns.messageId, to: helpers.taskMessages.id }),
    },
    verification: {},
  }),
);

export const authSchema = {
  user,
  session,
  account,
  verification,
  apikey,
};
