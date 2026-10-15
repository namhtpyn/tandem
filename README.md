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
- **Agent runs** — tasks assigned to AI are dispatched automatically to the agent's machine over SSH; output streams live into the task's workflow drawer with the full activity feed; success finishes the task, failure retries with backoff
- **Task attachments** — attach images/documents to a task description (paperclip in the editor, 20MB per file); inputs are pushed to the agent's machine over SFTP before each run and listed in its brief; files the agent leaves in its `out/` directory are collected back (50MB cap) and shown as run outputs; the sandbox copy is cleaned up once no run is active. Serve route honors etag revalidation
- **Task routing** — pending obligations are the single source of "who acts next" (questions move on forward, reviewers get approval rows per round; `question_holder_id`/`review_approvals` are gone). Assignee changes append to an immutable ledger. Tasks nest into subtasks (unlimited depth; children are full tasks) and a parent auto-blocks while any child is open, restoring its status when all children are done/abandoned. Agents propose routing (`[SUBTASKS]` / `[REASSIGN]` envelope markers parsed on run settle); a human confirms — the confirm flow is the single structural writer, escalating outside-chain nominees to the agent's supervisor and refusing ping-pong reassigns from history. The tasks page has a "Needs my decision" toggle with a live badge count (pending obligations on you)
- **Resilience** — hung agents time out (default 30 min), crash-orphaned runs are reaped, failed runs back off before retrying (1/5/15 min ladder; out-of-quota errors wait the full 15 min) — no retry storms
- **Auth** — email/password + runtime-configurable OIDC providers (admin UI, no restarts)
- **Model providers** — connection info only, keys live in the built-in vault and are delivered to agents at dispatch; works with OpenAI/Anthropic-compatible endpoints and more
- **Health** — `/health/ready` (Postgres + migrations) and `/health/live` endpoints

Everything is realtime: open tabs update the moment anything changes — no refresh.

## Quick start (Docker)

```bash
docker run -d \
  --name tandem \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://tandem:tandem@db:5432/tandem \
  ghcr.io/namhtpyn/tandem
```

Bring your own Postgres (any managed instance works). Open
`http://localhost:3000` and sign in with the seeded admin:

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
| `REDIS_URL` | no | Redis for durable dispatch queue, multi-replica live updates, and cache; unset = single-process mode |
| `TANDEM_RUN_TIMEOUT_MS` | no | hard cap on one agent run (default 30 min) |
| `TANDEM_ATTACHMENTS_DIR` | no | where attachment bytes live (default `./data/attachments` — mount a volume in Docker) |
| `TANDEM_OIDC_ISSUER` + `_CLIENT_ID` + `_CLIENT_SECRET` (+ `_LABEL`) | no | env-fallback single OIDC provider; more via admin UI |

Migrations apply at boot (bundled with the server; no CLI step).

## Support

Issues and questions: [GitHub issues](https://github.com/namhtpyn/tandem/issues).
Developer docs: [AGENTS.md](AGENTS.md) · [SPEC.md](SPEC.md).

## License

MIT
