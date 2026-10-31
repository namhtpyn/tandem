# tandem SPEC

Behavioral spec for the Tandem company workspace. The README covers usage;
this file is the contract. Numbers, endpoints, and invariants here are
authoritative for implementation and review.

## Product

Human + AI employees, one hierarchy. Work is assigned as tasks; AI assignees
execute via the Hermes agent on SSH environments the operator controls.
Remote-only: the agent never runs on the Tandem server itself.

## Milestones

| id  | scope                                                                                 | status  |
| --- | ------------------------------------------------------------------------------------- | ------- |
| M1  | foundation: schema, auth, settings, health, admin shell, boot migrations + admin seed | shipped |
| M2  | environments: oRPC v2 live API, realtime admin UI, SSH probe (Bun Shell)              | shipped |
| M3  | employees (human/AI, title, managerId, org view                                       | planned |
| M4  | tasks CRUD, assignee, status                                                          | shipped |
| M4+ | workflow (question chain, unanimous review), agent dispatcher + streamed runs         | shipped |
| M5  | runner: per-env serial queue, SSH one-shot Hermes, stream capture                     | shipped |
| M6  | ship: tests at 100%, CI, semantic-release, GHCR, docs                                 | shipped |

## Domain model

Default minting law (2026-10-20): every id and every timestamp is minted by the
APP, never the DB — drizzle `.$default(() => uuidv7())` on ids (v7 from the
`uuid` package), `.$default(() => new Date())` on created/started timestamps,
`.$default(...).$onUpdate(() => new Date())` on updated_at. Legacy DB-level
`DEFAULT now()` columns remain in the DDL but are dormant (drizzle always
supplies values). Applies to both schema.ts and the generated schema.auth.ts.

```
environments(id, name, host, port, username, secret_id -> vault_secrets.id set null, secret_usage SSH_KEY|SSH_PASSWORD, host_key_fingerprint (TOFU store — see Environments procedures), created_at, updated_at)
employees(id, name, kind: human|ai, title, manager_id -> employees.id, environment_id -> environments.id, instructions, created_at, updated_at)
tasks(id, title, description, assignee_id -> employees.id, status, created_at, updated_at)
task_messages(id, task_id -> tasks.id cascade, author_id -> user.id set null, body, created_at) — one ordered conversation thread per task AND the single activity store (task_activity DROPPED 2026-10-30 — workflow verbs write here + a task_message_activities extension row; run bookkeeping lives on the run rows only); per-kind extension tables (1:1; task_message_activities(message_id -> task_messages.id cascade, payload jsonb)) hold the structured payload — the kind is whichever extension exists, no kind column; STATUS rows are pipeline bookkeeping (never thread items, never shipped in briefs)
task_runs(id, message_id -> task_messages.id cascade NOT NULL, employee_id -> user.id set null, session_id, environment_id, status running|done|failed, exit_code, output (full — no truncation), prompt (the exact brief sent for the turn, null on pre-2.26 rows), started_at, finished_at) — MESSAGE-FIRST (user design, 2026-10-26): the run's thread turn; the task is reached via the message (no task_runs.task_id); session_id = the ACP session this run used — ONE session per task PER EMPLOYEE (review turns by other employees never resume the assignee's session; there is no tasks.acp_session_id)
tasks.workflow: owner_id, reviewers text[], question_chain text[] (loop guard state)
task_obligations(id, task_id -> tasks.id cascade, employee_id -> user.id, role: answer|approval, status: pending|fulfilled|cancelled, created_at, resolved_at, resolved_by) — single source of "who acts next"; replaces question_holder_id + review_approvals (one migration backfills and drops both). answer moves on forward (old row resolved, new row pending); approvals spawn one row per reviewer per round (shared timestamp = round identity; a round with any cancelled row is dead -> request-changes resets approvals); drives the waiting-on-you inbox + badge (tasks.inbox: items + counts by role) and the company-wide awaiting-decision queue (2026-10-31, #91): tasks.listPaged accepts awaitingDecision — true = ONLY tasks holding ≥1 PENDING obligation (any role, any holder; the empty set short-circuits to an empty page), composable with q/statusId/inboxOfMe, omitted/false = no filtering; session tier — every authenticated reader sees the company queue, not just their own
task_assignments(id, task_id cascade, employee_id set null, reason, actor_id, started_at, ended_at) — append-only assignee ledger; current assignee stays denormalized on tasks.assignee_id; every change (create/update/reassign) flows through recordAssignment; derived "X -> Y" activity; recent rows feed the reassign ping-pong loop guard
tasks.parent_task_id -> tasks.id (set null), tasks.pre_block_status — subtask nesting, unlimited depth; children are full tasks (own assignee/runs/reviewers); parent auto-blocks while any child is non-terminal (done or cancelled-category), restoring pre_block_status when all children land terminal — derived, no drift; UNBLOCK RESTORE LAW (2026-10-31, #88): the restore target resolves against task_statuses before the write — an unknown/malformed id falls back to to-do (this write bypasses the setStatus membership guard, so a stale id would re-create a dangling tasks.status — the #62 class), and a working-category target restores to to-do instead (a working status must be backed by a live run; the dispatcher scans ready-category only, so restore-to-doing dead-ended the task — prod 9515f3f8 sat stranded 4+ days after its 2026-10-27 unblock); submit is refused while children are open; child briefs carry "This is a subtask of: <parent title>"
task_proposals(id, task_id cascade, run_id cascade, kind: subtasks|reassign, payload jsonb, status: proposed|executed|rejected, decision_note, decided_by, decided_at, created_at) — agent routing proposals read ONLY from the settled run's JSON envelope (its `subtasks`/`reassign` fields — envelope-only routing, 2026-10-26: no [SUBTASKS]/[REASSIGN] text markers, so echoed task content can never route); human confirms via tasks.confirmProposal/rejectProposal — the confirm flow is the single structural writer. AUTO-EXECUTION LAW (2026-10-16): when EVERY routing target of a proposal resolves inside the proposing agent's own supervision chain, the proposal executes immediately at settle (no approval) through the same confirm path; outside-chain targets or unnamed routing still wait for a human, and the ping-pong loop guard still applies (a guarded target stays proposed rather than executing): subtasks are created full (assignee kept when inside the agent's supervision chain, else escalated to the agent's supervisor; unknown names land unassigned), reassigns write through the ledger with a loop guard refusing recent assignees; rejected notes ride the next brief to prevent re-propose loops
seeded statuses add blocked (paused; next: todo) and cancelled (the cancelled-category terminal — abandoned was merged into it; abandonReview lands on cancelled)
tasks page: "Needs my decision" toggle (badge = pending obligations on the current user) filters the list/board to inbox tasks; the company-wide "Awaiting decision" chip (deep link /tasks?awaiting=1, URL synced on toggle) filters to every task holding a pending obligation for anyone, rows and mobile cards badge "Waiting on <holder>" (the pending answer holder; "Review pending" while the task sits in-review with approvers outstanding) and the overview carries a live-count card linking to the same filtered list
task page Details: assignee / project / status are editable in place (USelect per row on one aligned grid; reassign records the assignment ledger row). STATUS FREEDOM (owner ruling 2026-10-27): manual status is free — the transition graph is advisory, the server nextIds/terminal guards are gone, every surface (sidebar, list, board drag) sets any status; built-in statuses are editable in Statuses manager; blocked transitions = {todo, cancelled}, no self-edge; MEMBERSHIP GUARD (2026-10-30): setStatus resolves the target against task_statuses ids and refuses unknown values ('status does not exist') — tasks.status has no FK by design, so the write path is what keeps dangling legacy strings (dispatch/board ghosts) out. RUN LOCK (owner ruling 2026-10-27): while a run is live the running agent owns the task — status AND assignee edits are rejected server-side and disabled in the UI. Reviewers are a multi-select in TaskEditorModal (explicit reviewers only — see the review law)
task page = one conversation thread (owner rulings 2026-10-26): the main column is the chat timeline (brief bubble, agent run turns showing the settled result body with expandable raw input = the exact brief + raw output = the full transcript + collected deliverables, activity notes) loaded via tasks.threadList (GET + change events); the composer is ONE state-aware Send button (COMPOSER LAW, owner ruling 2026-10-27): agent running → submitting STEERS the live run (a second session/prompt injected on the open ACP stream via the onSessionOpen hook; steerRun tri-state steered|refused|stopped, a live run always blocks a second dispatch); agent stopped → submitting DISPATCHES the run (needs an AI assignee + non-terminal status; steer-or-dispatch decided in tasks.note, which returns the outcome); while waiting-answer the send IS the answer verb and the agent's turn re-arms; review verdicts live in a GitHub-style TaskReviewBox rendered only while in-review (optional note rides Approve / Request changes / Reject); Ask is an AGENT verb only (envelope question) — there is no human Ask button; sidebar workflow verbs are contextual per state and render ONLY where the server accepts them (Submit for review only for a human assignee in a working status — AI assignees submit via the envelope; Abandon in working states; Forward only while the task is waiting-answer AND the viewer is the current answer holder — the pending answer obligation's holder — hidden in working states and for non-holders)
dispatcher STALE-JOB LAW (2026-10-16): queued dispatch jobs may be stale (duplicates stacked while the worker was busy); the worker re-checks the task is in a ready-category status before dispatching and SKIPS ineligible jobs silently (no re-run, no retry storm, no flip back to doing), and dispatch enqueues carry jobId=taskId with removeOnComplete so duplicates cannot stack while a job waits/runs while re-dispatch after completion still works. LIVENESS SWEEP (2026-10-31, #88): the dispatcher tick also returns working-category AI-assigned tasks whose newest run is settled (no RUNNING run) — or that have no runs at all — for more than 15 minutes back to to-do; fail_streak and dispatch_after are untouched (liveness repair, not failure) and human-assigned tasks are exempt (manual status freedom); a working status is backed by a live run or it bounces — covering unblock relics, missed status remaps and settle-path regressions; the 10-min probe alerts on the same shape past 25 min (i.e. only if the sweep itself stopped working). dispatcher: scans ready-category statuses; PER-AGENT BullMQ queues (tandem-dispatch-<agentId>), each worker concurrency = tasksPerAgent (Settings page, default 1, zod 1..32, workers re-sync on settings.update without a redeploy) — agents always run in parallel with each other, one agent runs up to N tasks at once; no-redis fallback enforces the same cap via in-memory slots; NO TIME-AWARE THROTTLING (2026-10-31, owner ruling — the 2026-10-31 PEAK CADENCE experiment is REVERTED): the effective per-agent cap is `tasks_per_agent` at every hour of every day — no peak windows, no multipliers, no wall-clock logic anywhere in the dispatch path. Agents run full speed 24/7. run output kept in full (no tail truncation); no settle activity note — the run card's status pill is the verdict
dispatch = ACP v1 (Agent Client Protocol): the runner spawns the employee's ACP executable (required, shell-word-validated, e.g. `hermes acp`) over SSH stdio — env blob byte-count framed on stdin ahead of the JSON-RPC stream; initialize advertises NO client capabilities (no fs/terminal — agents never touch Tandem); the ACP session lives on the run row (task_runs.session_id): the first turn opens session/new, later turns by the SAME employee resume their latest run's session on the task (answer, review, re-dispatch), the agent process is killed after every turn; sessions are per task×employee — a reviewer's turn never resumes the assignee's session; permission requests are auto-allowed (headless parity) and logged; session/update streams live into the run log (agent_message_chunk text is line-coalesced — one log line per source newline, pending remainder flushed at turn end, force-flush at 400 chars; a full agent_message logs once and only when nothing streamed); agent run timeout: Settings-page value `run_timeout_ms` (default 30 min, min 1 min) — the ACP turn is cancelled at the cap and the reaper uses the same value; no env var; the exact prompt (brief) is persisted on the run row before the turn starts so the task page can show the input alongside the output; brief assembly is layered (user law 2026-10-16): COMPANY (settings-page companyPrompt) -> PROJECT (projects.prompt of the task's project) -> employee standing instructions -> TASK; empty layers are omitted entirely; the run's persisted prompt shows the exact assembled brief. RELAY BRIEF LAW (owner ruling 2026-10-26): the full layered brief ships only on the reader's FIRST run of a task; every later prompt is a conversation relay, not a re-brief — org header + CONTINUATION line (fresh-session hint) + ONLY task_messages newer than the reader's own last finished run + attachments + contract: other agents' turns relay settled as kind result, the reader's own turns are skipped (they live in its session), STATUS bookkeeping never ships; prompt message lines ship WHOLE (never truncated); OUTPUT CONTRACT (the one JSON envelope line) and the DELIVERABLES out-dir ride EVERY prompt. REVIEW LAW (FINAL SPEC v2, owner-locked 2026-10-29): EXPLICIT reviewers only — the org supervisor is NOT a default quality gate; a submit with no reviewers completes immediately. With reviewers the task parks in-review with one approval obligation + a pending task_reviews row per reviewer per round (the round's rows carry `result_body` = the submitted result being judged, written at round open; review turns re-armed by an answer or unblock replay it — the retired task_activity archive is gone); row statuses: pending -> approved | rejected | request_change, plus escalated | superseded (audit-only, never count). AI reviewers get a review TURN on the SAME task — a run row by them under their own session (never the assignee's), never a subtask, and reviews are never re-reviewed. SEQUENTIAL (owner ruling 2026-10-29): ONE AI review turn in flight per task; a verdict's settle path LAZY-MINTS the next pending reviewer's run onto their per-agent queue — Redis holds zero waiting state (BullMQ = execution bus + retry ladder only; PARKS ARE NOT STORED ANYWHERE: park = no job + existing status/rows describing why). Later reviewers' briefs carry VERDICTS SO FAR (current round's decided verdicts, always). Review brief = the ONE buildBrief composer in review mode (org -> COMPANY -> TASK UNDER REVIEW -> SUBMITTED RESULT -> verdicts-so-far -> relayed activity -> collected submission attachments as evidence -> review contract; no DELIVERABLES/out-dir) — the hand-rolled reviewBrief is deleted. Envelope (STRICT, review vocabulary): {"kind": "approved"|"rejected"|"request_change"|"escalate", body} — identity-mapped onto row statuses; legacy result/blocked kinds parse as VERDICT-LESS. END-OF-ROUND MATRIX (round settles only after the LAST verdict — a request_change never closes the round early): all approved -> done; all rejected -> cancelled (AI-only rounds included — option A); any request_change or split vote -> task back to ready, notes riding the next brief; resubmission opens round+1 from the task's reviewer roster. Humans and AI are one currency. ESCALATE = referral, never settles: body "escalate to <name> for reviewing — <why>"; the system validates the target is up-chain of the escalator (never the assignee — self-review — never self, never an existing round reviewer; supervisor==assignee is skipped walking up; an unparseable/invalid target falls back to the direct supervisor) and MUTATES THE TASK'S REVIEWER ROSTER (escalator out, supervisor in — one source of truth); escalator's row -> escalated, fresh PENDING row same round, obligations move; jury shrink accepted (the stand-in carries the full vote); escalation consumes the reviewer's turn and never loops (up-chain only, owner at top). ESCALATE IS AI-REVIEWER ONLY (owner ruling 2026-10-29): humans can never submit an escalate review — the review box carries no escalate verb and the router exposes no human escalate procedure; a human reviewer who cannot judge reassigns or forwards the task instead. PARKS (the round cannot progress without a human: escalation with no eligible target, verdict-less review after its one bounded re-dispatch, access-missing escalation) flip the task in-review -> BLOCKED (system action; waiting-answer stays reserved for agent questions); owner resolution unblocks back to in-review and the sequence resumes at the parked point. MANUAL SETTLE teardown: owner moves the task to done/cancelled -> all PENDING rows supersede, approval obligations cancel, any in-flight review run is refused by the terminal gate — the owner's move is the verdict of record. Review settle-failure PARKS (never the work-run backoff ladder); a verdict-less review NEVER silently approves. The work-run envelope {kind: result|question|blocked, body, subtasks?, reassign?} is unchanged: question/blocked park the task on its owner (waiting-answer), result submits for review / completes; routing rides the same line and is read ONLY from the settled envelope; DELIVERABLES (artifacts-only note) rides every WORK prompt: real files to out/, never the result — no RESULT.md. the run settles on ONE JSON line — the envelope {kind: result|question|blocked, body, subtasks?, reassign?} parsed from the final agent_message (fence-tolerant bottom-up scan; a flush-split verdict is rejoined once) — and it drives the workflow: question/blocked park the task on its owner (status waiting-answer + pending answer obligation — never done), result (or no envelope) submits for review / completes; routing rides the same line and is read ONLY from the settled envelope (in-chain auto-exec law unchanged; echoed task content can never route); session/cancel on timeout then kill; no HERMES_HOME override (the host's own agent home is the employee's environment; isolation = ACP sessions); NO sftp/fuse mounts — bytes stage to ~/.tandem/<taskId>/attachments/ (see attachments flow)
task_attachments(id, task_id -> tasks.id cascade, run_id, kind: input|output, filename, mime, size, sha256, created_by, created_at); bytes on disk per task under TANDEM_ATTACHMENTS_DIR (default root /tandem → /tandem/tasks/<taskId>/attachments/<id> — all Tandem data lives under /tandem/**)
attachments flow: inputs upload via REST multipart (20MB cap, MIME allowlist png/jpeg/webp/gif/pdf/txt/md/csv/json/zip), token `![name](attachment-<id>)` / `@[name](attachment-<id>)` embedded in description; dispatch pushes inputs over SFTP to the agent host at ~/.tandem/<taskId>/attachments/ (relative paths resolve to the environment SSH user's home on every OS; chowned to the agent uid on hermes images) and lists them in the brief; PROMPT-INLINE IMAGES (2026-10-31): at dispatch, input image attachments that pass the prompt filter (mime png/jpeg/webp/gif, 0 < size <= 5 MiB, first 6 by filename asc within a 12 MiB total budget) are read from the attachment store and inlined into the ACP session/prompt as image content blocks (base64 data + mimeType, filename-asc order) appended after the brief text block; SFTP staging stays universal — inlining is additive and the staged copy remains the agent's fallback; filter misses (mime, empty file, size, count, budget) and unreadable bytes stay staged-only, the brief labels inlined images 'image — inlined into this prompt' and staged-only ones 'image — view with your image tool', and an unreadable inline candidate logs a dispatch line instead of failing the run; mid-turn steers remain text-only; review turns inline the same input set (reviewers judge the evidence first-hand); agent deliverables left in ~/.tandem/<taskId>/attachments/out/ are collected back post-run (50MB cap) as kind='output' rows under their run; RESULT-MESSAGE ATTACHMENTS (2026-10-31): image outputs ride the run's result message itself — images collected from out/ that pass the message filter (mime png/jpeg/webp/gif, 0 < size <= 5 MiB, <= 6 per message, ordered by filename asc) are appended to the run message body as `![name](attachment-<id>)` tokens right after the parsed result text; the run bubble parses body tokens (images inline, files as chips — same grammar as the brief) and the deliverable gallery under the bubble shows only outputs NOT already carried by the body; non-images, filter misses, review runs (collect runs detached) and collects slower than the bounded 20s verdict window stay gallery-only rows; the sandbox task dir ~/.tandem/<taskId>/ is removed once no run of the task is running; serve route GET /api/attachments/:id honors etag (sha256) revalidation
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

- better-auth + drizzle adapter; canonical tables `user`, `session`, `account`, `verification`
- password email + generic OIDC (any count, discovery via `issuer/.well-known/openid-configuration`)
- sign-up is **closed** after any user exists (403 `sign-up is closed`); the FIRST user (boot-seeded admin) holds the instance; the first user to sign up is promoted to `admin` via the user.create after hook
- OIDC user creation is never gated
- account linking: an OIDC account NEVER links into an existing local user on the strength of the
  provider being admin-configured (`trustedProviders` stays unset — a trusted provider id bypasses
  the `email_verified` gate in better-auth's implicit linking, so any identity on the IdP that
  self-asserts an existing user's email could take over that account, incl. the boot-seeded admin).
  Implicit linking requires the IdP to assert a verified email claim (`email_verified`), and the
  local target user must itself be verified (`requireLocalEmailVerified` default true)
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

## Roles & access

Three roles on `user.role` — ADMIN, EMPLOYEE, VIEWER (unknown values read as
VIEWER; new users default VIEWER; the first boot user claims ADMIN).
**Enforcement is server-side at the oRPC kernel; UI gating is UX, never the
boundary.** Tier matrix:

| tier     | who                    | surface                                                                                                                                                                                                                                                                        |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| public   | anonymous              | `auth.config`, `auth.configLive`, `auth.session`, `meta.version`, better-auth `/auth/**`, `/health/*`                                                                                                                                                                          |
| session  | any authenticated user | every read procedure (list/listPaged/live/detail/thread/runs/inbox/subtasks/assignments/proposals/reviews/activity/titles/apiKeys), `changes.live`                                                                                                                             |
| employee | EMPLOYEE + ADMIN       | every `tasks.*` and `projects.*` write (create/update/setStatus/note/ask/forward/answer/submit/approve/requestChanges/reject/abandon/dispatch/remove/proposals confirm+reject) and `statuses.assign` (Jev auto-assign); verdict writes are additionally HUMAN-only (see below) |
| admin    | ADMIN only             | vault (secrets + folders, all verbs), providers (all verbs incl. models), oidc.replace, settings.update, environments create/update/remove/probe, employees create/update/remove, access-key mint/update/revoke, statuses save/remove                                          |

Wrong role → `FORBIDDEN`; anonymous → `UNAUTHORIZED`. Reads never exceed the
session tier; an admin-surface write is never wired below the admin tier. A
role gate is part of the procedure definition itself (kernel middleware), so a
router file wired with bare `protectedProcedure` on an admin-tier write is a
defect even if a client never calls it.

Review verdicts are HUMAN-only: `tasks.approve`, `tasks.requestChanges` and
`tasks.reject` additionally verify the session's credential origin — a session
backed by an API key (agent credential) is `FORBIDDEN` even with the right
role, enforced server-side in the same gate middleware. Origin resolution:
better-auth's apiKey plugin fabricates the session for an `x-api-key` request
with `session.id = apiKey.id`, so a session id that resolves to an `apikey`
row is an agent credential; a human UI session (a `session` row) is never
affected. Agent review verdicts ride the run envelope (`source: 'ai'` in
`recordVerdict`), never these procedures — the gate guards the human verdict
surface, not the agent one.

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
  `NOT_FOUND` 404, `BAD_REQUEST` 400 schema violations, `FORBIDDEN` 403 role gate
  (see Roles & access)
- input validation: zod `strictObject` everywhere (unknown keys rejected)
- wire format: POST `/rpc/<path>`, body `{ "json": <input> }`,
  `content-type: application/json`; responses `{ "json": <result> }`

### Procedures (complete list)

| procedure             | auth    | input                                                     | result                                                                                              |
| --------------------- | ------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `meta.version`        | none    | —                                                         | `{version}`                                                                                         |
| `changes.live`        | session | —                                                         | SSE stream of `{resource, action}` change events (post-load invalidation only — never carries data) |
| `auth.config`         | none    | —                                                         | plain GET `{passwordEnabled, oidcEnabled, providers:[{id,label}]}`                                  |
| `auth.configLive`     | none    | —                                                         | live `{passwordEnabled, oidcEnabled, providers:[{id,label}]}`                                       |
| `auth.session`        | none    | —                                                         | session payload or null                                                                             |
| `settings.live`       | session | —                                                         | live `{disablePasswordLogin, flags}`                                                                |
| `settings.update`     | admin   | `{disablePasswordLogin?, flags?}`                         | `{ok}` (400 when disabling with no OIDC provider; 400 on flag-name/flag-count violations)           |
| `oidc.live`           | session | —                                                         | live provider list with `hasSecret`, never secrets                                                  |
| `oidc.replace`        | admin   | `{providers:[{id?,label,issuer,clientId,clientSecret?}]}` | `{ok,count}` (secrets write-only; ids server-generated for new providers)                           |
| `environments.live`   | session | —                                                         | live snapshot of all environments                                                                   |
| `environments.create` | admin   | `{name,host,port?,username}`                              | created row                                                                                         |
| `environments.update` | admin   | `{id,name,host,port?,username}`                           | updated row                                                                                         |
| `environments.remove` | admin   | `{id}`                                                    | `{ok}`                                                                                              |
| `environments.probe`  | admin   | `{id}`                                                    | `{ok,detail,durationMs}`                                                                            |

Wiring follows the official oRPC docs: Nuxt adapter (`toWebRequest` +
`RPCHandler` with `onError` interceptor), Better Auth lazy `getSession`
shared getter in context, TanStack Query via `createTanstackQueryUtils`
(`liveOptions` for streams), SSR via `createRouterClient` (in-process, no
HTTP hop; per-request so cookies stay current).

### Environments procedures

| procedure             | input                           | result                                   |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `environments.live`   | —                               | live snapshot stream of all environments |
| `environments.create` | `{name,host,port?,username}`    | created row                              |
| `environments.update` | `{id,name,host,port?,username}` | updated row                              |
| `environments.remove` | `{id}`                          | `{ok:true}`                              |
| `environments.probe`  | `{id}`                          | `{ok,detail,durationMs}`                 |

- names unique (409 on clash, including rename onto another row)
- probe: BatchMode ssh (`StrictHostKeyChecking=accept-new`, ConnectTimeout 5),
  marker `tandem-probe-ok`; Bun Shell first, node `child_process` fallback for
  non-bun runtimes; `TANDEM_SSH_TIMEOUT_MS` overrides the 10s kill timer
- SSH host-key law (TOFU): EVERY ssh2 transport — run exec, file shuttle,
  ACP-over-SSH — passes a `hostVerifier`: the presented wire-format host key is
  fingerprinted `sha256:<base64 nopad>` and compared against
  `environments.host_key_fingerprint`. First contact (no stored fingerprint)
  accepts and PERSISTS the fingerprint (trust-on-first-use); a stored
  fingerprint mismatch FAILS CLOSED — connection refused, step FAILED,
  `[ssh-hostkey] HOST KEY MISMATCH` audit line. A first-contact persist failure
  degrades to per-connection accept-new (the mismatch guard stays intact). The
  probe keeps spawn-ssh `StrictHostKeyChecking=accept-new` (unchanged).

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

Stored settings are integrity-audited: each KNOWN key must hold a value its
write path could have produced — checked at boot and on every readiness call
(see Health); a corrupt value reads fail-closed AND degrades readiness until
the row is repaired.

### Feature flags

One settings key `flags` stores a JSON object `{ "<name>": boolean }` — the
runtime feature-flag namespace. Flags are managed ONLY through
`settings.update({ flags })`; a flags write REPLACES the stored map. Flag
names match `^[a-z][a-z0-9_.-]{0,39}$` and at most 20 flags are stored; the
update proc validates and rejects violations BEFORE any write. Reads are
tolerant and fail closed: a missing key, unparsable JSON, a non-object
payload, invalid names or a map over the cap all read as NO flags — every
flag is OFF unless explicitly `true`, and an unrecognized flag name is
simply off. `settings.list` / `settings.live` carry the parsed map as
`flags`.

Off is the default state of every flagged feature: with the flag off, the
feature surface renders exactly its pre-flag behavior. Flags decouple
release from deployment — behavior flips through `settings.update` with no
image change and no redeploy. First flagged feature: `tasks.turn-durations` —
the task thread renders each settled run turn's wall-clock duration
(`finishedAt − startedAt`, e.g. `4m 05s`); running/unfinished turns and
non-positive deltas render no duration.

## Health

- `GET /health/live` → 200 always, `{ ok: true }`; touches nothing
- `GET /health/ready` → 200 `{ ok: true, migrations: 'complete' }` only when
  Postgres answers `SELECT 1`, every migration has applied, AND every stored
  settings value passes its integrity validation; otherwise 503
  `{ ok: false }` — the body stays generic in every failure case, corrupt
  keys and reasons go to server logs only, never to the unauthenticated probe
- Settings integrity (live detector): every KNOWN settings key's stored value
  is validated against the shape its write path produces — logged once at
  boot, re-checked on every readiness call. One or more corrupt values
  degrade readiness (503) until the rows are repaired; tolerant fail-closed
  READS are unchanged (validation detects corruption, it never alters read
  results), and unknown keys are never validated (extensible namespace)

## Boot sequence

1. module init: `sqlClient` built from `DATABASE_URL`; missing env → process exits 1
2. `migrations` ledger table is created; bundled drizzle SQL is applied in name order
3. no users & `user` rows → seed admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, defaults `admin@tandem.local` / tandem-admin); seed never runs when users exists
4. password stored as better-auth scrypt (`salt:hash`, no prefix label)

## UI laws

- Modals (UModal) size app-wide via `app/app.config.ts` — mobile keeps the library
  default `w-[calc(100vw-2rem)]` card; desktop grows with the viewport
  (`sm:max-w-xl md:max-w-2xl lg:max-w-3xl`) instead of the stock 512px `max-w-lg`.
  No per-modal width pins; the environments delete-confirm pin was removed for uniformity.

## Routes table

| method   | path                         | auth                         | purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST/GET | `/auth/**`                   | public (policy gates inside) | better-auth handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET      | `/health/live`               | none                         | liveness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET      | `/health/ready`              | none                         | readiness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET      | `/api/auth-config`           | none                         | login capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST     | `/rpc/**`                    | varies (see API law)         | all application procedures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST     | `/rpc/**`                    | session (oRPC middleware)    | oRPC v2 procedures (see API law)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST     | `/api/tasks/:id/attachments` | session                      | multipart attachment upload (REST exception, like avatar)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET      | `/api/attachments/:id`       | session                      | serve attachment bytes (etag = sha256, 304 revalidation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET      | `/`                          | none                         | 302 → `/admin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET      | `/tasks`                     | session                      | task list/board (mobile-first cards; titles link to the task page; every card kebab carries Workflow opening the same workflow drawer as the desktop row button — the drawer is reachable at phone widths with ≥44px tap targets; the List/Board view toggle is pinned OUTSIDE the toolbar's right-aligned action scroller — always visible at phone widths, ≥44px tap targets, no horizontal scrolling to reach it; every horizontally scrollable control row in the toolbar area (the status filter strip and the toolbar action scroller) carries a right-edge scroll affordance (fade mask — a clipped trailing control reads as scrollable, never as broken) and every control in them (status tabs, Decisions/Awaiting chips, toolbar buttons) exposes a ≥44px touch target at phone widths, visual size unchanged from sm up) |
| GET      | `/tasks/:id`                 | session                      | task info page: chat thread (brief, run turns with raw input/output folds, activity) + sidebar (details, review checklist, routing proposals, contextual verbs) + composer; data loads via GET procs and refetches on change events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Testing contract

- vitest unit suite: one disposable Postgres database per test file, created/dropped in `afterAll`; real migrations, real better-auth, real h3 events (real `createEvent` + a fake node req with body chunks)
- coverage gates: 100% statements/branches/functions/lines; barrel/re-export files type-only modules and test-only modules are excluded
- Playwright e2e: a built server against a dedicated `tandem_e2e` database; covers login, bad password, OIDC settings round-trip, health, gates
- `bun run typecheck` + `bun run build` clean in CI

## Deployment

- Docker multi-stage ( bun; `APP_VERSION` build arg bakes the served version
- CI: build + typecheck + supply-chain gate; release: semantic-release (conventional commits) on main + GHCR image publish
- supply-chain contract: every GitHub Actions `uses:` ref is pinned to a full 40-hex commit SHA (in-repo `./path` actions and `docker://image@sha256:…` refs excepted); every workflow file declares an explicit top-level `permissions:` block, scoped per job to only what that job consumes; Dockerfile `FROM` bases are pinned `tag@sha256:<digest>`. The gate (`scripts/check-supply-chain.sh`) runs as a CI job on every PR and push — any violation fails the run; a violation landing on main auto-files a `[supply-chain]` issue carrying the exact findings (deduped against the already-open one by findings fingerprint)
- image: `ghcr.io/namhtpyn/tandem`

## Ops drills (game-day restore drill)

- The restore drill is a game day run against the TEST stack only: the local
  `tandem-pg` / `tandem-test-redis` containers, a throwaway compose project,
  and a drill-owned `tandem_drill` database inside the test Postgres. It never
  touches prod. `scripts/restore-drill.sh` refuses to run unless the operator
  passed `DRILL_TEST_STACK=1`, `DATABASE_URL` points at the local test stack,
  no prod marker (prod stack/host names) appears in the environment or in the
  host's container list, and no unit/e2e run is in flight (file lock + process
  check) — the test stack is shared with the local gates.
- A drill that only restores rows proves backup paths, not detection paths, so
  every scenario injects a real failure and times the response: `redis-stop`
  (dispatch bus down; detector: service ping), `bad-tag-deploy` (nonexistent
  image tag — the v-prefix deploy class; detector: deploy exit status plus a
  silent-no-op container check), `settings-corrupt` (garbage in a `settings`
  row; detector: row integrity probe against the pre-inject backup — the
  drill's heal verifier; the LIVE app-level detector is readiness 503 while
  any known key fails validation, per Health). Each
  scenario backs up before it injects, heals, and verifies green; per-scenario
  time-to-detect and time-to-heal are recorded.
- A scenario that heals only because the drill itself probed it is a detection
  gap: gaps are recorded in the drill report and become watchdog/audit issues.
  `scripts/restore-drill.sh --selfcheck` validates the guards with zero side
  effects and is asserted by a unit test; drill reports land with the ops
  evidence.
