# tandem

A company workspace where human employees and AI employees work together —
each with a title and a place in the hierarchy. AI employees are executed by
the [Hermes agent](https://github.com/nousresearch/hermes-agent) on your own
SSH environments; Tandem schedules, dispatches, and records every run.

Think of it as a lightweight org chart plus task board where some seats are
filled by agents you already run yourself.

## Features

- **Environments** — SSH targets (host, port, user) that run your AI agents; connection probe before use
- **Employees** — humans and AI in one directory; titles, hierarchy (org chart), AI bound to an environment + system instructions
- **Tasks** — assign to any employee (human or AI); question/answer chain with forwarding, unanimous review workflow before done; every task has a full info page (workflow actions, agent runs with their complete output, activity history)
- **Agent runs** — tasks assigned to AI are dispatched automatically to the agent's machine over SSH; output streams live into the task's workflow drawer with the full activity feed, and the exact prompt sent to the agent is kept on every run so you can see the input next to the output; success finishes the task, failure retries with backoff
- **Task attachments** — attach images/documents to a task description (paperclip in the editor, 20MB per file); inputs are pushed to the agent's machine before each run and listed in its brief; files the agent leaves in its `out/` directory are collected back (50MB cap) and shown as run outputs; the sandbox copy is cleaned up once no run is active
- **Task routing** — every task shows who acts next: questions move with forwarding, reviewers sign off round by round. Tasks nest into subtasks (unlimited depth); a parent automatically waits while any child is open. Agents can propose subtasks or a reassignment; a human confirms. The tasks page has a "Needs my decision" toggle with a live count
- **Resilience** — hung agents time out (default 30 min), crash-orphaned runs are reaped, failed runs back off before retrying (1/5/15 min ladder; out-of-quota errors wait the full 15 min) — no retry storms
- **Auth** — email/password + runtime-configurable OIDC providers (admin UI, no restarts)
- **Model providers** — connection info only, keys live in the built-in vault and are delivered to agents at dispatch; works with OpenAI/Anthropic-compatible endpoints and more
- **Health** — `/health/ready` (Postgres + migrations) and `/health/live` endpoints

Everything is realtime: open tabs update the moment anything changes — no refresh.

## Quick start (Docker Compose)

Tandem needs Postgres and Redis. Save as `compose.yaml` and `docker compose up -d`:

```yaml
services:
  tandem:
    image: ghcr.io/namhtpyn/tandem:latest
    restart: always
    ports:
      - '3000:3000'
    environment:
      DATABASE_URL: postgresql://tandem:tandem@tandem-db:5432/tandem
      REDIS_URL: redis://redis:6379
      BETTER_AUTH_SECRET: change-me
      TANDEM_VAULT_KEY: change-me # openssl rand -base64 32
    depends_on:
      tandem-db:
        condition: service_healthy
      redis:
        condition: service_healthy
  tandem-db:
    image: postgres:18
    restart: always
    environment:
      POSTGRES_USER: tandem
      POSTGRES_PASSWORD: tandem
      POSTGRES_DB: tandem
    volumes:
      - tandem-db-data:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U tandem -d tandem']
      interval: 5s
      timeout: 3s
      retries: 10
  redis:
    image: redis:8-alpine
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  tandem-db-data:
  redis-data:
```

Open `http://localhost:3000` and sign in with the seeded admin:

- email `admin@tandem.local`
- password `tandem-admin`

Override `ADMIN_EMAIL` / `ADMIN_PASSWORD` before first boot. The seed runs
only on a fresh database — never on restarts.

## Configuration

| env                                                                 | required     | purpose                                                                                                                                   |
| ------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | yes          | Postgres connection string                                                                                                                |
| `BETTER_AUTH_SECRET`                                                | in prod      | session signing                                                                                                                           |
| `BETTER_AUTH_URL`                                                   | no           | canonical origin override                                                                                                                 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`                                    | no           | first-boot seed overrides                                                                                                                 |
| `REDIS_URL`                                                         | **required** | Redis for the durable dispatch queue, live updates, and cache — validated at boot; the app refuses to start without it                    |
| `TANDEM_ATTACHMENTS_DIR`                                            | no           | Tandem data root (default `/tandem`; attachment bytes live under `/tandem/tasks/<taskId>/attachments/` — mount one volume at the root)    |
| `TANDEM_VAULT_KEY`                                                  | **yes**      | 32-byte base64 key for vault envelope encryption — REQUIRED, no fallback (`openssl rand -base64 32`); losing it loses every stored secret |
| `TANDEM_OIDC_ISSUER` + `_CLIENT_ID` + `_CLIENT_SECRET` (+ `_LABEL`) | no           | env-fallback single OIDC provider; more via admin UI                                                                                      |

Migrations apply at boot (bundled with the server; no CLI step).

## Support

Issues and questions: [GitHub issues](https://github.com/namhtpyn/tandem/issues).
Developer docs: [AGENTS.md](AGENTS.md) · [SPEC.md](SPEC.md).

## License

MIT
