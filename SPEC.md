# tandem SPEC

Behavioral spec for the Tandem company workspace. The README covers usage;
this file is the contract. Numbers, endpoints, and invariants here are
authoritative for implementation and review.

## Product

Human + AI employees, one hierarchy. Work is assigned as tasks; AI assignees
execute via the Hermes agent on SSH environments the operator controls.
Remote-only: the agent never runs on the Tandem server itself.

## Milestones

| id | scope | status |
|---|---|---|
| M1 | foundation: schema, auth, settings, health, admin shell, boot migrations + admin seed | shipped |
| M2 | environments: oRPC v2 live API, realtime admin UI, SSH probe (Bun Shell) | shipped |
| M3 | employees (human/AI, title, managerId, org view | planned |
| M4 | tasks CRUD, assignee, status | shipped |
| M4+ | workflow (question chain, unanimous review), agent dispatcher + streamed runs | shipped |
| M5 | runner: per-env serial queue, SSH one-shot Hermes, stream capture | shipped |
| M6 | ship: tests at 100%, CI, semantic-release, GHCR, docs | shipped |

## Domain model

```
environments(id, name, host, port, username, created_at, updated_at)
employees(id, name, kind: human|ai, title, manager_id -> employees.id, environment_id -> environments.id, instructions, created_at, updated_at)
tasks(id, title, description, assignee_id -> employees.id, status, created_at, updated_at)
runs(id, task_id -> tasks.id cascade, employee_id -> tandem_user.id set null, environment_id, status running|done|failed, exit_code, output (full — no truncation), prompt (the exact brief sent for the turn, null on pre-2.26 rows), started_at, finished_at)
tasks.workflow: owner_id, reviewers text[], question_chain text[] (loop guard state)
task_obligations(id, task_id -> tasks.id cascade, employee_id -> tandem_user.id, role: answer|approval, status: pending|fulfilled|cancelled, created_at, resolved_at, resolved_by) — single source of "who acts next"; replaces question_holder_id + review_approvals (one migration backfills and drops both). answer moves on forward (old row resolved, new row pending); approvals spawn one row per reviewer per round (shared timestamp = round identity; a round with any cancelled row is dead -> request-changes resets approvals); drives the waiting-on-you inbox + badge (tasks.inbox: items + counts by role)
task_assignments(id, task_id cascade, employee_id set null, reason, actor_id, started_at, ended_at) — append-only assignee ledger; current assignee stays denormalized on tasks.assignee_id; every change (create/update/reassign) flows through recordAssignment; derived "X -> Y" activity; recent rows feed the reassign ping-pong loop guard
tasks.parent_task_id -> tasks.id (set null), tasks.pre_block_status — subtask nesting, unlimited depth; children are full tasks (own assignee/runs/reviewers); parent auto-blocks while any child is non-terminal (done or cancelled-category), restoring pre_block_status when all children land terminal — derived, no drift; submit is refused while children are open; child briefs carry "This is a subtask of: <parent title>"
task_proposals(id, task_id cascade, run_id cascade, kind: subtasks|reassign, payload jsonb, status: proposed|executed|rejected, decision_note, decided_by, decided_at, created_at) — agent routing proposals parsed from run output on settle ([SUBTASKS] title :: desc :: assignee | … / [REASSIGN] Name — reason); human confirms via tasks.confirmProposal/rejectProposal — the confirm flow is the single structural writer: subtasks are created full (assignee kept when inside the agent's supervision chain, else escalated to the agent's supervisor; unknown names land unassigned), reassigns write through the ledger with a loop guard refusing recent assignees; rejected notes ride the next brief to prevent re-propose loops
seeded statuses add blocked (paused; next: todo) and cancelled (the cancelled-category terminal — abandoned was merged into it; abandonReview lands on cancelled)
tasks page: "Needs my decision" toggle (badge = pending obligations on the current user) filters the list/board to inbox tasks
dispatcher: scans ready-category statuses; per-agent serial dispatch; run output kept in full (no tail truncation); no settle activity note — the run card's status pill is the verdict
dispatch = ACP v1 (Agent Client Protocol): the runner spawns the employee's ACP executable (required, shell-word-validated, e.g. `hermes acp`) over SSH stdio — env blob byte-count framed on stdin ahead of the JSON-RPC stream; initialize advertises NO client capabilities (no fs/terminal — agents never touch Tandem); ONE session per task: tasks.acp_session_id created on first dispatch, resumed on later turns (answer, review, re-dispatch), the agent process is killed after every turn; permission requests are auto-allowed (headless parity) and logged; session/update streams live into the run log (agent_message_chunk text is line-coalesced — one log line per source newline, pending remainder flushed at turn end, force-flush at 400 chars; a full agent_message logs once and only when nothing streamed); agent run timeout: Settings-page value `run_timeout_ms` (default 30 min, min 1 min) — the ACP turn is cancelled at the cap and the reaper uses the same value; no env var; the exact prompt (brief) is persisted on the run row before the turn starts so the task page can show the input alongside the output; the envelope parses from the final agent_message; session/cancel on timeout then kill; no HERMES_HOME override (the host's own agent home is the employee's environment; isolation = ACP sessions); NO sftp/fuse mounts — bytes stage to ~/.tandem/<taskId>/attachments/ (see attachments flow)
task_attachments(id, task_id -> tasks.id cascade, run_id, kind: input|output, filename, mime, size, sha256, created_by, created_at); bytes on disk per task under TANDEM_ATTACHMENTS_DIR (default root /tandem → /tandem/tasks/<taskId>/attachments/<id> — all Tandem data lives under /tandem/**)
attachments flow: inputs upload via REST multipart (20MB cap, MIME allowlist png/jpeg/webp/gif/pdf/txt/md/csv/json/zip), token `![name](attachment-<id>)` / `@[name](attachment-<id>)` embedded in description; dispatch pushes inputs over SFTP to the agent host at ~/.tandem/<taskId>/attachments/ (relative paths resolve to the environment SSH user's home on every OS; chowned to the agent uid on hermes images) and lists them in the brief; agent deliverables left in ~/.tandem/<taskId>/attachments/out/ are collected back post-run (50MB cap) as kind='output' rows under their run; the sandbox task dir ~/.tandem/<taskId>/ is removed once no run of the task is running; serve route GET /api/attachments/:id honors etag (sha256) revalidation
redis (REDIS_URL; required in prod deployments, omitted only in single-process dev/tests): bullmq queue 'tandem-dispatch' (retries/backoff) + pub/sub change-bus fanout + cache; unset = in-process fallback
bun serve: NITRO_BUN_IDLE_TIMEOUT defaults to 255 (code, boot plugin — Bun's max; default 10s would kill idle SSE feeds); env can override
resilience: tasks.dispatch_after + fail_streak (backoff ladder 1m/5m/15m, quota -> 15m); reaper fails stale running rows past the run-timeout setting + grace; ssh keepalive 15s
```

Runner (M5) executes per run:

```
ssh -p <port> <user>@<host> hermes chat -q --query-file - --format stream-json
```

- prompt delivered on **stdin** (`--query-file -`) — no shell interpolation
- stdout is JSONL: `system/init` (model…), `text` deltas, `result` (final)
- the `result` event finalizes the run row
- one run at active per environment at a time (serial queue)

## Vault key law

- `TANDEM_VAULT_KEY` is REQUIRED (32-byte base64, `openssl rand -base64 32`); there is NO hardcoded fallback — a key shipped in the repo is a key everyone has. Wrong size or missing key throws at first use with a clear message. Losing the key loses every stored secret.

## Auth

- better-auth + drizzle adapter; canonical tables `tandem_user`, `tandem_session`, `tandem_account`, `tandem_verification`
- password email + generic OIDC (any count, discovery via `issuer/.well-known/openid-configuration`)
- sign-up is **closed** after any user exists (403 `sign-up is closed`); the FIRST user (boot-seeded admin) holds the instance; the first user to sign up is promoted to `admin` via the user.create after hook
- OIDC user creation is never gated
- model providers carry a SET of endpoints (const-object enum in `shared/api-styles.ts`, kinds
  LLM/DECISION/MODELS; at most one MODELS endpoint per provider) and are pure connection info — NO
  keys stored on the provider row. Base URL LAW: baseUrl = host root before /v1; adapters append
  /v1/... paths (`ENDPOINT_PATH`); the /models probe dispatches on the declared models endpoint and
  parses both `data[].id` (OpenAI/Anthropic) and `models[].name` (TypeSafe) shapes Auto-assign resolves the first provider with a
  decision style and adapts per protocol (SystemOne `state`/`questions` map vs OpenAI Decisions
  `input`/`questions` array, both normalized to `{choice, confidence, probabilities}`); the vault
  key comes from the Workspace AI settings assignment (`internal_decision`: providerId + optional
  model + vault keySecretId, validated kind-correct on save; garbage JSON parses to null). The same
  shape exists for `internal_llm` for future server-side features. Every decrypt is audited `use`
- admin manages the OIDC provider set at runtime (secrets live in the registry, never returned by `oidc.live` (only `hasSecret: true`)
- env fallback: exactly ONE provider (TANDEM_OIDC_ISSUER/_CLIENT_ID/_CLIENT_SECRET/_LABEL), used only when no stored registry exists

### Vault key law

- `TANDEM_VAULT_KEY` is REQUIRED (32-byte base64, `openssl rand -base64 32`); there is NO hardcoded fallback — a key shipped in the repo is a key everyone has. Wrong size or missing key throws at first use with a clear message. Losing the key loses every stored secret.

## Auth policy

- `passwordEnabled = !(settings.disablePasswordLogin)`
- `oidcEnabled = providers.length > 0`
- invariant: disabling password login with no OIDC provider configured is rejected 400

## API law (app-wide)

**Every** application API is an **oRPC v2** procedure mounted at `/rpc`
(RPCHandler, Fetch adapter, `toWebRequest`). The only REST routes left are
better-auth's own `/auth/**` protocol and the `/health/*` infra probes. Rules:

- every mutating procedure publishes to the in-process change bus
  (`server/utils/change-bus.ts`, MemoryPublisher) after commit
- **SSE law — streams only update an already-loaded page.** INITIAL page-load
  data always comes from a conventional GET: every live domain also ships a
  plain `list` procedure (`tasks.list`, `tasks.runsList`, `tasks.activityList`,
  `statuses.list`, `settings.list`, `oidc.list`, `providers.list`,
  `projects.list`, `environments.list`, `employees.list`,
  `employees.titles.list`, `vault.list`, `vault.folders.list`, `auth.config`)
  and pages mount those via `queryOptions`. After load, one app-wide SSE
  channel `changes.live` streams `{resource, action}` change events (no data);
  `app/composables/useChangeEvents.ts` (mounted once in `app.vue`) holds that
  connection (client-only, 2s reconnect backoff, aborted on scope teardown) and
  invalidates the matching TanStack Query prefix `['<resource>']`, so the
  invalidated GET queries refetch. Live generators (`*.live`: initial snapshot
  then re-emitted snapshots on matching change events, SSE
  `text/event-stream`) remain the streaming transport available for post-load
  consumers — no page opens a live stream as its data source anymore
- session context: lazy `getSession()` from better-auth per request (cookie
  headers forwarded); `UNAUTHORIZED` (401) for anonymous calls via middleware
- procedure errors map to oRPC codes: `CONFLICT` 409 duplicate name,
  `NOT_FOUND` 404, `BAD_REQUEST` 400 schema violations
- input validation: zod `strictObject` everywhere (unknown keys rejected)
- wire format: POST `/rpc/<path>`, body `{ "json": <input> }`,
  `content-type: application/json`; responses `{ "json": <result> }`

### Procedures (complete list)

| procedure | auth | input | result |
|---|---|---|---|
| `meta.version` | none | — | `{version}` |
| `changes.live` | session | — | SSE stream of `{resource, action}` change events (post-load invalidation only — never carries data) |
| `auth.config` | none | — | plain GET `{passwordEnabled, oidcEnabled, providers:[{id,label}]}` |
| `auth.configLive` | none | — | live `{passwordEnabled, oidcEnabled, providers:[{id,label}]}` |
| `auth.session` | none | — | session payload or null |
| `settings.live` | session | — | live `{disablePasswordLogin}` |
| `settings.update` | session | `{disablePasswordLogin?}` | `{ok}` (400 when disabling with no OIDC provider) |
| `oidc.live` | session | — | live provider list with `hasSecret`, never secrets |
| `oidc.replace` | session | `{providers:[{id?,label,issuer,clientId,clientSecret?}]}` | `{ok,count}` (secrets write-only; ids server-generated for new providers) |
| `environments.live` | session | — | live snapshot of all environments |
| `environments.create` | session | `{name,host,port?,username}` | created row |
| `environments.update` | session | `{id,name,host,port?,username}` | updated row |
| `environments.remove` | session | `{id}` | `{ok}` |
| `environments.probe` | session | `{id}` | `{ok,detail,durationMs}` |

Wiring follows the official oRPC docs: Nuxt adapter (`toWebRequest` +
`RPCHandler` with `onError` interceptor), Better Auth lazy `getSession`
shared getter in context, TanStack Query via `createTanstackQueryUtils`
(`liveOptions` for streams), SSR via `createRouterClient` (in-process, no
HTTP hop; per-request so cookies stay current).

### Environments procedures

| procedure | input | result |
|---|---|---|
| `environments.live` | — | live snapshot stream of all environments |
| `environments.create` | `{name,host,port?,username}` | created row |
| `environments.update` | `{id,name,host,port?,username}` | updated row |
| `environments.remove` | `{id}` | `{ok:true}` |
| `environments.probe` | `{id}` | `{ok,detail,durationMs}` |

- names unique (409 on clash, including rename onto another row)
- probe: BatchMode ssh (`StrictHostKeyChecking=accept-new`, ConnectTimeout 5),
  marker `tandem-probe-ok`; Bun Shell first, node `child_process` fallback for
  non-bun runtimes; `TANDEM_SSH_TIMEOUT_MS` overrides the 10s kill timer

### Realtime client

- `app/plugins/orpc.ts`: typed client; browser → `RPCLink('/rpc')`; SSR →
  in-process link (no HTTP hop) registered on `globalThis`
- `app/plugins/vue-query.ts`: TanStack Query; client-side
  `refetchOnMount: 'always'` re-opens SSE streams after hydration
- pages use `liveOptions()` live queries; mutations flow through the same
  client; every connected tab updates from the change bus

## Settings & OIDC (oRPC)

Handled by `settings.*` and `oidc.*` procedures above (see API law). The
OIDC env fallback (exactly ONE provider via `TANDEM_OIDC_ISSUER/_CLIENT_ID/
_CLIENT_SECRET/_LABEL`) applies only when no stored registry exists; stored
secrets are never returned.

## Health

- `GET /health/live` → 200 always, `{ ok: true }`; touches nothing
- `GET /health/ready` → 200 `{ ok: true, migrations: 'complete' }` only when Postgres answers `SELECT 1` AND every migration has applied; otherwise 503 `{ ok: false, error }`

## Boot sequence

1. module init: `sqlClient` built from `DATABASE_URL`; missing env → process exits 1
2. `tandem_migrations` ledger table is created; bundled drizzle SQL is applied in name order
3. no users & `tandem_user` rows → seed admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, defaults `admin@tandem.local` / tandem-admin); seed never runs when users exists
4. password stored as better-auth scrypt (`salt:hash`, no prefix label)

## UI laws

- Modals (UModal) size app-wide via `app/app.config.ts` — mobile keeps the library
  default `w-[calc(100vw-2rem)]` card; desktop grows with the viewport
  (`sm:max-w-xl md:max-w-2xl lg:max-w-3xl`) instead of the stock 512px `max-w-lg`.
  No per-modal width pins; the environments delete-confirm pin was removed for uniformity.

## Routes table

| method | path | auth | purpose |
|---|---|---|---|
| POST/GET | `/auth/**` | public (policy gates inside) | better-auth handler |
| GET | `/health/live` | none | liveness |
| GET | `/health/ready` | none | readiness |
| GET | `/api/auth-config` | none | login capabilities |
| POST | `/rpc/**` | varies (see API law) | all application procedures |
| POST | `/rpc/**` | session (oRPC middleware) | oRPC v2 procedures (see API law) |
| POST | `/api/tasks/:id/attachments` | session | multipart attachment upload (REST exception, like avatar) |
| GET | `/api/attachments/:id` | session | serve attachment bytes (etag = sha256, 304 revalidation) |
| GET | `/` | none | 302 → `/admin` |
| GET | `/tasks` | session | task list/board (mobile-first cards; titles link to the task page) |
| GET | `/tasks/:id` | session | task info page: header + workflow actions + agent runs (full output) + activity feed; data loads via GET procs and refetches on change events |

## Testing contract

- vitest unit suite: one disposable Postgres database per test file, created/dropped in `afterAll`; real migrations, real better-auth, real h3 events (real `createEvent` + a fake node req with body chunks)
- coverage gates: 100% statements/branches/functions/lines; barrel/re-export files type-only modules and test-only modules are excluded
- Playwright e2e: a built server against a dedicated `tandem_e2e` database; covers login, bad password, OIDC settings round-trip, health, gates
- `bun run typecheck` + `bun run build` clean in CI

## Deployment

- Docker multi-stage ( bun; `APP_VERSION` build arg bakes the served version
- CI: build + typecheck; release: semantic-release (conventional commits) on main + GHCR image publish
- image: `ghcr.io/namhtpyn/tandem`
