# AGENTS.md — Tandem

Rules for any AI agent working in this repository. Human-readable name: tandem.

## Stack

Nuxt 4 + Nitro, Nuxt UI v4, better-auth, drizzle + postgres.js, **oRPC v2**
(live queries over SSE — the app-wide API layer; only `/auth/**`, `/health/*`,
`/api/employees/:id/avatar` are REST), TanStack Query, VueUse, es-toolkit,
type-fest. bun-only toolchain (Bun Shell for all subprocess; vitest runs under Bun via `bun --bun vitest`). Postgres AND Redis are
required backing services (REDIS_URL — validated at boot by
`server/domains/kernel/env.ts`; BullMQ dispatch queue, pub/sub change-bus
fan-out, cache — no in-memory fallbacks).

## Mandated rule: manual browser test after every feature

**Before any feature is considered complete — and again before every commit that
ships a UI or behavior change — the agent MUST manually exercise the app in a real
browser, navigating and interacting like a human user:**

1. **Drive a real browser (Browser Use / Playwright-driven Chromium) with NATIVE
   input only.** Navigate by URL, click with trusted pointer events
   (`click_at_xy` — coordinates resolved from the accessibility tree +
   `DOM.getBoxModel`), type with the input tool (`fill_input`). **NEVER perform
   actions via `js()`/`eval`** (no `element.click()`, no synthetic dispatch, no
   script-driven form submission) and no headless DOM scraping. Interact the way
   a human's mouse and keyboard would.
2. **Look at every page state with a vision model.** Capture a screenshot at each
   meaningful step (page load, modal open, post-save, error state, empty state)
   and run it through the vision reviewer with a harsh UI-review prompt. Do not
   claim a screen "looks right" without having seen it.
3. **Cover the human path**: login → navigate → create → edit → delete → error
   cases (duplicate names, invalid input) → empty states → realtime updates
   where applicable.
   3a. **MOBILE FIRST — non-negotiable.** The UI is designed for phones first:
   every manual pass and every e2e visual check must run at a mobile viewport
   (e.g. 390x844) BEFORE desktop. Tables must collapse to card/stacked layouts
   on small screens (no horizontal scroll), modals must be bottom-sheet-like
   and reachable, tap targets ≥ 44px. A feature is not done until it works on
   a phone-width screen.
4. **js() is read-only**: page text/DOM may be READ via js for verification
   (asserting state after an action), but never to PERFORM actions.
5. **Then update the e2e suite accordingly**: encode what the manual pass taught
   (correct selectors, real flows, caught bugs) into `e2e/*.spec.ts`. The manual
   pass is the source of truth; the e2e suite is its automated memory.
6. Record the outcome in the commit/PR description: what was manually tested,
   what the vision review flagged, what was fixed.

curl/health checks and unit tests do NOT substitute for this rule. A feature is
done when a human-like pass through the UI succeeded AND the e2e suite encodes
it AND `bun run test` / `bun run typecheck` / `bun run build` are green.

## Standing engineering laws

- **Inferred DDD (architecture law, 2026-10-21):** domains are bounded contexts
  (`server/domains/<x>/`); every layer's type is DERIVED, never declared
  abstractly — no hand-written entity/DTO/interface/mapper layers:
  - Entity = `typeof table.$inferSelect` (the drizzle schema IS the entity and
    the ubiquitous language — intent-named tables/columns)
  - Contract = the zod schema on the oRPC procedure (validated + typed once,
    flows end to end; client types via `InferClientOutputs`)
  - Repository = RQB (`db.query.<table>`) used directly inside the domain
    service — drizzle IS the repository, no wrapper layer
  - Aggregate = a service FUNCTION owning its invariant end to end (e.g.
    `approveReview()` runs the whole review-round state machine), not a class
  - Domain event = `publishChange()` on the change-bus
  - Boundary: cross-domain calls go through the other domain's exported
    service functions (`import type` for shapes); never touch another
    domain's tables directly
    Enforcement of the boundary is by convention + review, not the compiler.
    Reach for classical DDD patterns (separate domain layer, repositories,
    mappers) only when a domain's invariants outgrow single service functions.
- **Enum law:** every enum is an `as const` object in `shared/enums/<name>.ts`,
  SCREAMING_SNAKE_CASE for BOTH property and value
  (`const ROLE = { ADMIN: 'ADMIN' } as const`), one file per enum owning the
  enum plus its related types/variables; derive the union type with
  `ValuesOf<typeof X>`; zod edges use `z.enum(X)` directly; never TS `enum`.
  Changing a DB-stored enum value ships a guarded `UPDATE ... WHERE old-value`
  remap in the same migration as the default flip.
- **MOBILE FIRST — the UI is designed for phones.** Every screen is built and
  verified at a mobile viewport (390x844) before desktop: tables collapse to
  cards/stacked layouts (no horizontal scrolling), modals are reachable and
  bottom-sheet-like, tap targets ≥ 44px. Manual QA and e2e must include a
  mobile-viewport pass for every feature.
- **No /admin path prefix.** Pages live at the root: `/` (overview),
  `/environments`, `/employees`, `/settings`. Never introduce route prefixes
  without an explicit user decision.
- **oRPC v2 app-wide.** Only `/auth/**` (better-auth protocol) and `/health/*`
  (infra probes) may be plain REST. Everything else is an oRPC procedure.
- **Everything realtime — but SSE never serves the first load.** Live queries +
  SSE change-bus update every screen after mount without reload. The INITIAL data
  on first page load ALWAYS comes from a conventional GET query
  (`orpc.<x>.list.queryOptions`) — prefetchable, cacheable, SSR-safe. SSE
  (`liveOptions` = latest-event-replaces, `streamedOptions` = events-append, per
  orpc.dev/docs/integrations/tanstack-query) is only the post-load updater; never
  the primary fetch. If a streamed/live query is kept open client-side, follow the
  oRPC SSR pattern: cancel streams on success during SSR (dehydrate the snapshot)
  and `refetchOnMount: 'always'` on the client to reopen the stream.
- **Migrations are drizzle-kit generated, never hand-written** (2026-10-16). After
  editing `server/db/schema.ts`, run `bun run db:generate` and commit the folder it
  creates (SQL + snapshot). `drizzle/20261016151937_common_madame_hydra` is the
  single squashed baseline (schema + status seed), generated from the live prod
  schema via drizzle-kit pull/generate on 2026-10-16 — the 32 historical folders
  it replaced are gone. CI runs `bunx drizzle-kit check` as the drift guard. Hand-written
  migration folders are how the chain silently broke for 20 migrations.
- **Boot applies migrations with drizzle's own migrator** (2026-10-21) —
  `migrate()` from `drizzle-orm/postgres-js/migrator` at boot, ledger
  `drizzle.__drizzle_migrations`, dedupe by folder name. No hand-rolled
  scanner/ledger: the old `public.migrations` table is adopted into the
  drizzle ledger once (adoptLegacyLedger) so applied folders never replay.
- **Bun Shell for all subprocess** (multi-OS support law).
- **Postgres, never SQLite.** better-auth tables are ALWAYS CLI-generated
  (`bun run gen:auth`); never hand-edit inside the GENERATED markers.
- **Docs law:** README.md is for USERS (install, configure, use) — never developer
  internals. Developer-facing detail (architecture, test infra, internal env knobs like
  `TANDEM_FAKE_RUNNER`, `TANDEM_NO_DISPATCHER`, `TANDEM_TEST_DATABASE_URL`, roadmap/milestones)
  lives HERE in AGENTS.md or SPEC.md. **Every functional change ships with matching
  README.md (user impact) + SPEC.md (schema/behavior) updates in the SAME commit.** Stale
  docs = shipped bug.
- **Dev workflow:** `bun run dev` (Nuxt), `bun run test` (needs local Postgres; one throwaway
  DB per file via `TANDEM_TEST_DATABASE_URL`), `bun run test:coverage` (100% gates),
  `bun run test:e2e` (Playwright, `tandem_e2e` DB, webServer :4100; logins are cookie-injected
  via better-auth test-utils by default — `TANDEM_E2E_FAST_LOGIN=0` forces the UI form),
  `bun run typecheck`. CI adds a redis service (port 6399) for the bullmq/pubsub integration tests.
- **Test layout:** vitest projects — `unit` (server/composables, 100%×4 coverage law) and
  `nuxt` (happy-dom component tests in `test/nuxt/` via `@nuxt/test-utils` `mountSuspended`;
  coverage off). Router procedures are invoked through the official `call()` helper
  (`test/unit/helpers/procs.ts`) — never poke `['~orpc']` internals. The better-auth test instance
  is `buildAuthForTest()` (ctx.test helpers); the production singleton must never expose them.
- **Roadmap:** M1 auth/settings/health/admin ✅ · M2 environments ✅ · M3 employees + org chart ✅ ·
  M4 tasks ✅ (+workflow, agent runs) · M5 SSH runner ✅ · M6 ship: CI/release/GHCR/docs ✅.
- bun-only toolchain; Nuxt UI components; zod strict inputs on every procedure.
  **Zod lives at the edge, and form schemas are separate from API schemas:**
  validation runs only on user input in routers — never `.parse()` in services
  (services take plain typed arguments). Frontend form schemas are LOOSE
  (`.nullish()` + `.transform(v => (v ? v : null))` — UI inputs emit `undefined`/`''`,
  never null); server oRPC input schemas are STRICT. Never validate a form with
  the server schema; never loosen the API schema for a component.
- **Const-object "enums", never TS `enum` nor bare string unions.** Define closed
  value sets as frozen const objects, derive types from them, and validate shape
  with `satisfies`:

  ```ts
  const PROVIDER_KIND = { LLM: 'LLM', DECISION: 'DECISION' } as const;
  type ProviderKind = ValueOf<typeof PROVIDER_KIND>;

  const PROVIDER_API_STYLE = {
    [PROVIDER_KIND.LLM]: { 'OPENAI-COMPLETIONS': 'OPENAI-COMPLETIONS' /* … */ },
    [PROVIDER_KIND.DECISION]: { 'TYPESAFE-SYSTEMONE': 'TYPESAFE-SYSTEMONE' /* … */ },
  } as const satisfies Record<ProviderKind, Record<string, string>>;
  ```

  Why: single source of truth (add a value once, every type, zod schema, and
  reverse lookup update), grouping keys stay valid `ProviderKind`s at compile
  time, and lookups (`styleKind(s)`) replace scattered string-literal switches.
  Store the leaf value in the DB; derive the group by lookup, never store both.

- **Enum constants are `SCREAMING_SNAKE_CASE`, for BOTH properties and values**
  (`PROVIDER_API_STYLE.LLM['ANTHROPIC-MESSAGES'] === 'ANTHROPIC-MESSAGES'`;
  `PROVIDER_KIND.DECISION === 'DECISION'`). Lowercase/camelCase const-object
  enums are a bug — rename on sight. Type names stay PascalCase.
- **Every enum gets an exhaustive label map**: `PROVIDER_API_STYLE_LABEL:
  { readonly [K in ProviderApiStyle]: string }` (mapped type, not `Record` —
  `Record` over computed keys collapses to `Record<never, string>` and silently
  disables exhaustiveness). UI dropdowns/badges render labels from these maps,
  never raw enum values. Adding an enum value without its label = type error.
- **Compile-time exhaustiveness everywhere — leave no room for current or future
  mistakes.** Concretely:
  - Derive unions by indexed access per group (`type LlmApiStyle = ValueOf<
    typeof PROVIDER_API_STYLE['LLM']>`) and union the groups. Do NOT nest
    `ValueOf<ValueOf<…>>` through computed keys — it collapses to `never`/`{}`
    and silently disables every downstream check.
  - Never hand-write a union that mirrors a const object (`'OPENAI-COMPLETIONS' |
    'OPENAI-RESPONSES' | …`). Hand-written copies drift; derived unions can't.
  - Switches/branches over enum values must end with an exhaustiveness guard
    (`default: const _x: never = style`), so adding a value breaks the build at
    every decision site, not at runtime.
  - zod schemas build from the same source (`z.enum(ALL_API_STYLES)`), never a
    re-typed literal list.

## Domain invariants (schema laws)

- User = employee, 1:1 both ways. No separate employees table.
- AI-ness is DERIVED: a row in `ai_employees` means AI agent; absence
  means human. No `kind` column anywhere.
- Supervision is many-to-many, DAG-checked at write time, self-supervision
  impossible via DB CHECK.

## Server domain structure (NestJS-style)

**Never create `server/modules/` — it is a reserved nitro scan directory** (auto-loaded as nitro module defs; frozen objects there crash any fresh-install build with "Attempted to assign to readonly property"). The domain tree is `server/domains/`.

- Every resource lives in `server/domains/<name>/` with `<name>.router.ts`
  (procedure wiring ONLY) and `<name>.service.ts` (row mapping, queries,
  business logic). Pure helpers keep a `.util.ts` suffix in the same folder.
- Routers consume services, never the reverse; services never import routers.
- Modules never import each other's routers; shared procedure primitives come
  from `server/domains/kernel/kernel.ts` (base, protectedProcedure,
  liveGenerator, publishChange). Row-mapping service helpers may be imported
  cross-module when genuinely shared (keep it rare).
- All routers merge in `server/domains/app.router.ts`; `server/routes/rpc/[...].ts`
  imports appRouter + `domains/kernel/context.buildServerContext` to create the
  oRPC handler. `/health/*` and `/auth/**` stay REST outside modules.
- `server/utils/` DOES NOT EXIST anymore — every service lives in its domain
  (`auth.service.ts`, `settings.service.ts`, `decision.service.ts`, …) and
  tests import from `server/domains/` directly.
- Adding a resource = new module folder + registration in app.router.ts.

## Better-auth schema law

- Auth tables (`user/session/account/verification/apikey`) are ALWAYS
  generated by the better-auth CLI into **server/db/schema.auth.ts** (a fully
  generated file — no markers, no splicing): `bun run gen:auth`
  (scripts/gen-auth-schema.ts wraps `bunx auth generate` against
  scripts/auth.config.ts — the plugin mirror of server/utils/auth.ts).
  schema.ts imports and re-exports it; NEVER hand-edit schema.auth.ts.
- Changing auth config (plugins/fields) = edit scripts/auth.config.ts AND
  server/utils/auth.ts, run gen:auth, hand-write the drizzle migration.
- CI regenerates and fails on any diff (drift guard) — regen must be idempotent.
- Relations are hand-owned via `defineRelations` in schema.ts; the CLI's
  `defineRelationsPart` block is stripped by the script.

## Task workflow (user laws, 2026-10-13)

- Statuses: `todo → doing → waiting-answer →(answer)→ todo` and `doing →(submit)→ in-review →(unanimous approve)→ done`; `in-review →(changes)→ todo`, `in-review →(reject)→ cancelled` (human-only verdict), `in-review →(abandon)→ cancelled`.
- **Owner ≠ supervisor**: owner routes questions; creator by default; no hierarchy coupling.
- **All reviewers must approve** (unanimous) before done. Reviewer or assignee can be AI or human — no restriction anywhere.
- **Forward chain is free** but stops at the top of the hierarchy (employee with no supervisors must ANSWER, cannot receive forwards) and never revisits someone already in the chain.
- Workflow logic lives in `server/domains/tasks/workflow.service.ts`; the router only wires procedures (`ask`, `note`, `forward`, `answer`, `submit`, `approve`, `requestChanges`, `reject`, `abandon`, `dispatch`, `thread`, `activity`).
- `tasks.activity` is a liveGenerator over `['taskActivity','tasks']` — publish both resources on every workflow write.
- Coverage law: no defensive `?? fallback` on NOT NULL columns (istanbul counts the dead arm and CI enforces 100% branches).

### Owner laws (2026-10-26)

- **Message-first schema:** runs link to tasks via thread messages — `task_runs.message_id` (NOT NULL) joins `task_messages`; no `task_runs.task_id`, no `tasks.acp_session_id` (the ACP session lives on `task_runs.session_id`, one per task×employee; reviewer turns never resume the assignee's session); `task_message_activities` remains the activity extension.
- **Relay brief law:** the TASK block ships only on an agent's FIRST run of a task; later prompts are a conversation relay — only task_messages newer than the reader's own last finished run (other agents' turns relay as `result`, the reader's own turns are skipped — they live in session memory, STATUS bookkeeping never ships) + a CONTINUATION line for fresh sessions; the OUTPUT CONTRACT + DELIVERABLES path ride every prompt.
- **No prompt truncation:** prompt message lines ship WHOLE — never clipped.
- **Envelope-only routing:** one JSON line `{kind, body, subtasks?, reassign?}` is the whole verdict contract; read routing proposals ONLY from the settled envelope — no `[SUBTASKS]`/`[REASSIGN]` text markers; the in-chain auto-exec law is unchanged.
- **Explicit reviewers only:** no supervisor default — a submit with no reviewers completes immediately; unanimous approve → done, the FIRST change-request bounces the round, reject is human-only terminal (cancelled).
- **Reviews happen ON the task:** AI reviewers get a review TURN (a run row on the same task), never a review subtask; reviews are never re-reviewed.
- **Note verb:** the task-page composer posts plain notes (`tasks.note`, no state change) and auto-becomes Send answer while the task waits for one.
- **Contextual workflow verbs:** review verdicts live in the TaskReviewBox (own input); Ask is an agent verb only (envelope question — no human button); sidebar verbs render per state (Submit for review is the human assignee's move — agents submit via the envelope).
