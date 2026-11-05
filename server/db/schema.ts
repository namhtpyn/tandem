import { sql } from 'drizzle-orm';
import { defineRelations } from 'drizzle-orm';
// Drizzle rc (Relations v2) over Postgres.
import {
  type AnyPgColumn,
  boolean,
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
  // SSH host-key TOFU store (SPEC: Environments procedures): 'sha256:<base64
  // nopad>' fingerprint of the server's wire-format host key; null = first
  // contact. A mismatch fails the connection closed before auth.
  hostKeyFingerprint: text('host_key_fingerprint'),
  // last probe verdict (PROBE VERDICT LAW, SPEC Environments procedures):
  // persisted so the manager's Status column renders from data — null = never
  // probed. Cleared by an update that changes a connection field.
  lastProbeOk: boolean('last_probe_ok'),
  lastProbeDetail: text('last_probe_detail'),
  lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
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

// MCP registry: admin-managed catalog of MCP servers agents bind to
// (slice 1: transport http; slice 2 adds OAuth per binding; slice 3 adds the
// stdio transport — SPEC "MCP (registry + per-agent bindings) — stdio
// transport (#270 slice 3)")
export const mcpServers = pgTable('mcp_servers', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  name: text('name').notNull().unique(),
  // 'http' = slice-1/2 contract (url + Authorization header credential);
  // 'stdio' = slice-3 contract (command + args, credential rides as an env var)
  transport: text('transport').notNull().default('http'),
  url: text('url'),
  // stdio only — ABSOLUTE path to the executable (ACP v1 wire contract)
  command: text('command'),
  // stdio only — JSON array of strings, serialized
  args: text('args'),
  // stdio only — env var name the binding credential rides at dispatch/probe
  credentialEnvVar: text('credential_env_var'),
  notes: text('notes').notNull().default(''),
  // authKind 'none' = slice-1 contract (static credential verbatim);
  // 'oauth' = per-binding authorization via the Tandem-hosted PKCE flow
  authKind: text('auth_kind').notNull().default('none'),
  oauthAuthorizeUrl: text('oauth_authorize_url'),
  oauthTokenUrl: text('oauth_token_url'),
  oauthRevocationUrl: text('oauth_revocation_url'),
  oauthScopes: text('oauth_scopes'),
  oauthClientId: text('oauth_client_id'),
  // confidential-client secret (registry-level, write-only vault law)
  oauthClientSecretId: text('oauth_client_secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Binding = the permission unit: one AI employee × one registry entry with an
// optional vault credential (the secret plaintext is the Authorization header
// value, decrypted server-side at dispatch ONLY) + the binding-level probe
// verdict (PROBE VERDICT LAW: both outcomes persist; null = never probed).
export const mcpServerBindings = pgTable(
  'mcp_server_bindings',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    secretId: text('secret_id').references(() => vaultSecrets.id, { onDelete: 'set null' }),
    lastProbeOk: boolean('last_probe_ok'),
    lastProbeDetail: text('last_probe_detail'),
    lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('mcp_server_bindings_employee_server_uniq').on(t.employeeId, t.serverId),
    index('mcp_server_bindings_server_idx').on(t.serverId),
  ],
);

// OAuth tokens per binding (#270 slice 2): access + refresh tokens encrypted
// at rest under the vault envelope law — decrypted server-side at
// dispatch/probe ONLY; no API surface ever returns them (masked status only).
// config_fingerprint pins the contract the tokens were minted under: a token
// row whose fingerprint no longer matches the server config is INERT (deleted
// on read) — old-contract tokens can never ride a dispatch, whatever race the
// wipe path lost.
export const mcpOauthTokens = pgTable('mcp_oauth_tokens', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  bindingId: text('binding_id')
    .notNull()
    .unique()
    .references(() => mcpServerBindings.id, { onDelete: 'cascade' }),
  accessTokenEnc: text('access_enc').notNull(),
  refreshTokenEnc: text('refresh_enc'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  scope: text('scope').notNull().default(''),
  configFingerprint: text('config_fingerprint').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});

// Single-use authorize-flow state (#270 slice 2): the state row IS the
// authorization proof — consumed on FIRST callback use, 10-minute TTL, and
// bound to a fingerprint of the OAuth config it was minted under (a pre-edit
// callback can never complete against a changed contract).
export const mcpOauthStates = pgTable('mcp_oauth_states', {
  id: text('id')
    .primaryKey()
    .$default(() => uuidv7()),
  bindingId: text('binding_id')
    .notNull()
    .references(() => mcpServerBindings.id, { onDelete: 'cascade' }),
  codeVerifier: text('code_verifier').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  configFingerprint: text('config_fingerprint').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .$default(() => new Date()),
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
    /** park origin (#202): the status a review park flipped BLOCKED from; null = not parked */
    parkFromStatus: text('park_from_status'),
    /** PARK-REARM LAW (#211): an infra-class review park re-arms on a bounded backoff
     * ladder — attempts burned in the current cycle (ladder length + 1 = exhausted,
     * final park) and the earliest time the dispatcher tick may re-run the unblock
     * arm; null = nothing scheduled (decision park, exhausted ladder, or no park) */
    parkRearmAttempts: integer('park_rearm_attempts').notNull().default(0),
    parkRearmAfter: timestamp('park_rearm_after', { withTimezone: true }),
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
    // gating walks children on every status change (#130)
    index('tasks_parent_task_idx').on(t.parentTaskId),
    // PARK-REARM scan (#211): partial — only rows with a scheduled re-arm, near-empty
    index('tasks_park_rearm_idx')
      .on(t.parkRearmAfter)
      .where(sql`park_rearm_after is not null`),
    // newest-first sort for every list shape — snapshot + listPaged top-N (#220)
    index('tasks_created_id_idx').on(t.createdAt, t.id),
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
    /** run-level retry bookkeeping (owner ruling 2026-10-28): the BullMQ job replays
     * THIS row on transport retries (same frozen prompt), so attempts counts
     * executions of one dispatch intent — 1 = first try. */
    attempts: integer('attempts').notNull().default(1),
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
    // the reaper's RUNNING sweep every dispatcher tick (#130)
    index('task_runs_status_idx').on(t.status),
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
    /** the submitted result this round judges — set at round open; re-armed
     * review turns (answer/unblock) replay it without an activity archive */
    resultBody: text('result_body'),
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

// ---------- channels (backend relay, #271) ----------

// Channel thread ↔ Tandem task mapping: one platform thread (matrix room) maps
// to ONE task; a top-level channel message creates a new task + mapping.
// Keyed by the ORIGINATING adapter (kind:homeserver) — two homeservers may use
// the same room id, and bindings/behavior must never cross between them.
export const channelThreads = pgTable(
  'channel_threads',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    channel: text('channel').notNull(), // adapter kind ('matrix')
    adapter: text('adapter').notNull(), // adapter key (kind:homeserver)
    threadRef: text('thread_ref').notNull(), // platform thread id (room id)
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('channel_threads_adapter_thread_uq').on(t.adapter, t.threadRef)],
);

// Inbound durability (SPEC: Channels — deploys drop nothing): the raw event
// lands FIRST; the BullMQ job processes it afterwards and is idempotent via
// processedAt. Unique (adapter, externalId) makes adapter replays no-ops —
// keyed by adapter so two homeservers' event ids can never collide.
export const channelEvents = pgTable(
  'channel_events',
  {
    id: text('id')
      .primaryKey()
      .$default(() => uuidv7()),
    channel: text('channel').notNull(),
    /** originating adapter key (`kind:homeserver`) — routing/bindings/acks
     * resolve through THIS, never through a kind-wide config match */
    adapter: text('adapter').notNull(),
    externalId: text('external_id').notNull(), // platform event id (matrix event_id)
    threadRef: text('thread_ref').notNull(),
    sender: text('sender').notNull(), // platform user id
    body: text('body').notNull(),
    raw: jsonb('raw').notNull().default({}),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .$default(() => new Date()),
    /** worker claim CAS (stale after a TTL): concurrent jobs (deferral cycles,
     * sweep, deploy overlap) can never route the same event twice */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('channel_events_adapter_external_uq').on(t.adapter, t.externalId),
    // boot sweep predicate — partial index keeps the scan proportional to the
    // UNPROCESSED backlog, not to unbounded raw history
    index('channel_events_unprocessed_idx')
      .on(t.processedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

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
    taskRuns,
    taskMessages,
    taskMessageActivities,
    taskReviews,
    taskStatuses,
    modelProviders,
    projects,
    taskProposals,
    taskAttachments,
    channelThreads,
    channelEvents,
    mcpServers,
    mcpServerBindings,
    mcpOauthTokens,
    mcpOauthStates,
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
    mcpServers: {},
    mcpServerBindings: {
      employee: helpers.one.user({ from: helpers.mcpServerBindings.employeeId, to: helpers.user.id }),
      server: helpers.one.mcpServers({ from: helpers.mcpServerBindings.serverId, to: helpers.mcpServers.id }),
      secret: helpers.one.vaultSecrets({ from: helpers.mcpServerBindings.secretId, to: helpers.vaultSecrets.id }),
    },
    mcpOauthTokens: {
      binding: helpers.one.mcpServerBindings({
        from: helpers.mcpOauthTokens.bindingId,
        to: helpers.mcpServerBindings.id,
      }),
    },
    mcpOauthStates: {
      binding: helpers.one.mcpServerBindings({
        from: helpers.mcpOauthStates.bindingId,
        to: helpers.mcpServerBindings.id,
      }),
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
