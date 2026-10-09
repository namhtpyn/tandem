# tandem

A company workspace where human employees and AI employees work together —
each with a title and a place in the hierarchy. AI employees are executed by
the [Hermes agent](https://github.com/nousresearch/hermes-agent) on your own
SSH environments; Tandem schedules, dispatches, and records every run.

Think of it as a lightweight org chart plus task board where some seats are
filled by agents you already run yourself.

## Features

- **Environments** — SSH targets (host, port, user) that run Hermes; connection probe before use
- **Employees** — humans and AI in one directory; title, manager pointer (hierarchy), AI bound to an environment + system instructions
- **Tasks** — assign to any employee, track status, comment
- **Runner** — per-environment serial queue; each run executes
  `ssh <env> hermes chat -q --query-file - --format stream-json` with the prompt on stdin, capturing the JSONL stream live
- **Auth** — email/password + runtime-configurable OIDC providers (admin UI, no restarts)
- **Health** — split readiness (`/health/ready`: Postgres + migrations) and liveness (`/health/live`: always 200)

Stack: Nuxt 4 + Nitro, Nuxt UI v4, better-auth, drizzle + postgres.js,
**oRPC v2** (live queries over SSE), TanStack Query, VueUse, es-toolkit,
type-fest. bun-only toolchain (Bun Shell for all subprocess). Postgres is the
only backing service.

**Realtime everywhere**: domain data flows through oRPC live procedures at
`/rpc` — the admin UI subscribes to snapshot streams and updates in every
open tab the moment anything changes. No polling, no manual refresh.

## Quick start (Docker)

```bash
docker run -d \
  --name tandem \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://tandem:tandem@db:5432/tandem \
  ghcr.io/namhtpyn/tandem
```

Bring your own Postgres (any managed instance works). Open
`http://localhost:3000/admin` and sign in with the seeded admin:

- email `admin@tandem.local`
- password `tandem-admin`

Override `ADMIN_EMAIL` / `ADMIN_PASSWORD` before first boot. The seed runs
only on a fresh database — never on restarts.

## Configuration

| env | required | purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `BETTER_AUTH_SECRET` | in prod | session signing |
| `BETTER_AUTH_URL` | no | canonical origin override |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | first-boot seed overrides |
| `TANDEM_OIDC_ISSUER` + `_CLIENT_ID` + `_CLIENT_SECRET` (+ `_LABEL`) | no | env-fallback single OIDC provider; more via admin UI |

Migrations apply at boot (bundled with the server; no CLI step).

## Development

```bash
bun install
bun run dev            # Nuxt dev server
bun run test           # vitest unit suite (needs a local Postgres)
bun run test:coverage  # unit + 100% coverage gates
bun run test:e2e       # Playwright (builds nothing; expects bun build output)
bun run typecheck
```

Unit tests create one throwaway Postgres database per test file (drop on exit);
point them with `TANDEM_TEST_DATABASE_URL`. E2E uses `tandem_e2e` on the same
server, spawned by Playwright's `webServer` on port 4100.

Docs: [SPEC.md](SPEC.md) · [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

## Roadmap

- M1 — foundation: auth, settings, health, admin shell ✅
- M2 — environments: oRPC live API + realtime admin UI + SSH probe ✅
- M3 — employees + org chart
- M4 — tasks
- M5 — runner (SSH + Hermes stream capture)
- M6 — ship: CI, release, GHCR, docs ✅

## License

MIT
