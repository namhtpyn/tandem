# AGENTS.md — Tandem

Rules for any AI agent working in this repository. Human-readable name: tandem.

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
4. **js() is read-only**: page text/DOM may be READ via js for verification
   (asserting state after an action), but never to PERFORM actions.
5. **Then update the e2e suite accordingly**: encode what the manual pass taught
   (correct selectors, real flows, caught bugs) into `e2e/*.spec.ts`. The manual
   pass is the source of truth; the e2e suite is its automated memory.
5. Record the outcome in the commit/PR description: what was manually tested,
   what the vision review flagged, what was fixed.

curl/health checks and unit tests do NOT substitute for this rule. A feature is
done when a human-like pass through the UI succeeded AND the e2e suite encodes
it AND `bun run test` / `bun run typecheck` / `bun run build` are green.

## Standing engineering laws

- **oRPC v2 app-wide.** Only `/auth/**` (better-auth protocol) and `/health/*`
  (infra probes) may be plain REST. Everything else is an oRPC procedure.
- **Everything realtime.** Live queries + SSE change-bus; every screen reflects
  mutations from any client without reload.
- **Bun Shell for all subprocess** (multi-OS support law).
- **Postgres, never SQLite.** better-auth tables are ALWAYS CLI-generated
  (`bun run gen:auth`); never hand-edit inside the GENERATED markers.
- **Every functional change ships with matching README.md + SPEC.md updates in
  the SAME commit.** Stale docs = shipped bug.
- bun-only toolchain; Nuxt UI components; zod strict inputs on every procedure.

## Domain invariants (schema laws)

- User = employee, 1:1 both ways. No separate employees table.
- AI-ness is DERIVED: a row in `tandem_ai_employees` means AI agent; absence
  means human. No `kind` column anywhere.
- Supervision is many-to-many, DAG-checked at write time, self-supervision
  impossible via DB CHECK.
