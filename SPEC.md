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
| M2 | environments CRUD, SSH probe | planned |
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
- admin manages the OIDC provider set at runtime (secrets live in the registry, never returned by `GET /api/oidc` (only `hasSecret: true`)
- env fallback: exactly ONE provider (TANDEM_OIDC_ISSUER/_CLIENT_ID/_CLIENT_SECRET/_LABEL), used only when no stored registry exists

### Auth policy

- `passwordEnabled = !(settings.disablePasswordLogin)`
- `oidcEnabled = providers.length > 0`
- invariant: disabling password login with no OIDC provider configured is rejected 400

## Settings API

- `GET /api/settings` → `{ disablePasswordLogin: boolean }` (session required)
- `PUT /api/settings` `{ disablePasswordLogin?: boolean }` (session required; validated zod strictObject)
- `GET /api/oidc` → provider list with `hasSecret` flags (session required)
- `PUT /api/oidc` `{ providers: providerInput[] }` (session required)
  - new provider: id generated (uuid), secret required
  - edit: secret preserved when omitted; secret required to re stored value
  - unknown id + no stored secret: kept stored secret; new id generated
  - stored registry replaced wholesale; max 10 providers
- `GET /api/auth-config` → public `{ passwordEnabled, oidcEnabled, providers: [{id,label}] }`
- `GET /api/auth-session` → session shape or null ( `{ user: {id,name,email,role}, session: {expiresAt} }`
- `GET /api/version` → `{ version }` (`APP_VERSION` or `dev`)

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
| GET | `/api/auth-session` | none | current session |
| GET/PUT | `/api/settings` | session | auth settings |
| GET/PUT | `/api/oidc` | session | OIDC registry |
| GET | `/api/version` | none | build version |
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
