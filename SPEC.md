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
| M4 | tasks CRUD, assignee, status | planned |
| M5 | runner: per-env serial queue, SSH one-shot Hermes, stream capture | planned |
| M6 | ship: tests at 100%, CI, semantic-release, GHCR, docs | shipped |

## Domain model

```
environments(id, name, host, port, username, created_at, updated_at)
employees(id, name, kind: human|ai, title, manager_id -> employees.id, environment_id -> environments.id, instructions, created_at, updated_at)
tasks(id, title, description, assignee_id -> employees.id, status, created_at, updated_at)
runs(id, task_id -> tasks.id, environment_id, status, stream, result, exit_code, started_at, ended_at)
```

Runner (M5) executes per run:

```
ssh -p <port> <user>@<host> hermes chat -q --query-file - --format stream-json
```

- prompt delivered on **stdin** (`--query-file -`) — no shell interpolation
- stdout is JSONL: `system/init` (model…), `text` deltas, `result` (final)
- the `result` event finalizes the run row
- one run at active per environment at a time (serial queue)

## Auth

- better-auth + drizzle adapter; canonical tables `tandem_user`, `tandem_session`, `tandem_account`, `tandem_verification`
- password email + generic OIDC (any count, discovery via `issuer/.well-known/openid-configuration`)
- sign-up is **closed** after any user exists (403 `sign-up is closed`); the FIRST user (boot-seeded admin) holds the instance; the first user to sign up is promoted to `admin` via the user.create after hook
- OIDC user creation is never gated
- admin manages the OIDC provider set at runtime (secrets live in the registry, never returned by `oidc.live` (only `hasSecret: true`)
- env fallback: exactly ONE provider (TANDEM_OIDC_ISSUER/_CLIENT_ID/_CLIENT_SECRET/_LABEL), used only when no stored registry exists

### Auth policy

- `passwordEnabled = !(settings.disablePasswordLogin)`
- `oidcEnabled = providers.length > 0`
- invariant: disabling password login with no OIDC provider configured is rejected 400

## API law (app-wide)

**Every** application API is an **oRPC v2** procedure mounted at `/rpc`
(RPCHandler, Fetch adapter, `toWebRequest`). The only REST routes left are
better-auth's own `/auth/**` protocol and the `/health/*` infra probes. Rules:

- every mutating procedure publishes to the in-process change bus
  (`server/utils/change-bus.ts`, MemoryPublisher) after commit
- list endpoints are **live generators**: initial snapshot, then re-emitted
  snapshots on matching change events, streamed to clients as SSE
  (`text/event-stream`) — the UI never polls or invalidates
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

## Routes table

| method | path | auth | purpose |
|---|---|---|---|
| POST/GET | `/auth/**` | public (policy gates inside) | better-auth handler |
| GET | `/health/live` | none | liveness |
| GET | `/health/ready` | none | readiness |
| GET | `/api/auth-config` | none | login capabilities |
| POST | `/rpc/**` | varies (see API law) | all application procedures |
| POST | `/rpc/**` | session (oRPC middleware) | oRPC v2 procedures (see API law) |
| GET | `/` | none | 302 → `/admin` |

## Testing contract

- vitest unit suite: one disposable Postgres database per test file, created/dropped in `afterAll`; real migrations, real better-auth, real h3 events (real `createEvent` + a fake node req with body chunks)
- coverage gates: 100% statements/branches/functions/lines; barrel/re-export files type-only modules and test-only modules are excluded
- Playwright e2e: a built server against a dedicated `tandem_e2e` database; covers login, bad password, OIDC settings round-trip, health, gates
- `bun run typecheck` + `bun run build` clean in CI

## Deployment

- Docker multi-stage ( bun; `APP_VERSION` build arg bakes the served version
- CI: build + typecheck; release: semantic-release (conventional commits) on main + GHCR image publish
- image: `ghcr.io/namhtpyn/tandem`
