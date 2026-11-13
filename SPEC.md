# tandem SPEC

Behavioral spec for the Tandem company workspace. The README covers usage;
this file is the contract. Numbers, endpoints, and invariants here are
authoritative for implementation and review.

## Product

Human + AI employees, one hierarchy. Work is assigned as tasks; AI assignees
execute via the Hermes agent on SSH environments the operator controls.
Remote-only: the agent never runs on the Tandem server itself.

HUMAN-ONLY FRONTEND LAW: the frontend serves humans exclusively — agents
integrate via API/ACP and never shape the UI. UX MUST be great; the steps to
complete any task MUST be as few as possible. Every UI change is judged
against human clarity and step count first.

## Milestones

| id  | scope                                                                                 | status  |
| --- | ------------------------------------------------------------------------------------- | ------- |
| M1  | foundation: schema, auth, settings, health, admin shell, boot migrations + admin seed | shipped |
| M2  | environments: oRPC v2 live API, realtime admin UI, SSH probe (Bun Shell)              | shipped |
| M3  | employees: human/AI rows, titles, managerId, org graph view                           | shipped |
| M4  | tasks CRUD, assignee, status                                                          | shipped |
| M4+ | workflow (question chain, unanimous review), agent dispatcher + streamed runs         | shipped |
| M5  | runner: ACP v1 over SSH stdio, per-agent BullMQ queues, transcript capture            | shipped |
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
task_runs(id, message_id -> task_messages.id cascade NOT NULL, employee_id -> user.id set null, session_id, environment_id, status running|done|failed|stopped, exit_code, output (full — no truncation, except RETENTION LAW blanking on terminal-category tasks past the horizon), prompt (the exact brief sent for the turn, null on pre-2.26 rows), started_at, finished_at) — MESSAGE-FIRST (user design, 2026-10-26): the run's thread turn; the task is reached via the message (no task_runs.task_id); session_id = the ACP session this run used — ONE session per task PER EMPLOYEE (review turns by other employees never resume the assignee's session; there is no tasks.acp_session_id)
tasks.workflow: owner_id, reviewers text[], question_chain text[] (loop guard state)
task_obligations(id, task_id -> tasks.id cascade, employee_id -> user.id, role: answer|approval, status: pending|fulfilled|cancelled, created_at, resolved_at, resolved_by) — single source of "who acts next"; replaces question_holder_id + review_approvals (one migration backfills and drops both). answer moves on forward (old row resolved, new row pending); approvals spawn one row per reviewer per round (shared timestamp = round identity; a round with any cancelled row is dead -> request-changes resets approvals); drives the waiting-on-you inbox + badge (tasks.inbox: items + counts by role) and the company-wide awaiting-decision queue (2026-10-31, #91): tasks.listPaged accepts awaitingDecision — true = ONLY tasks holding ≥1 PENDING obligation (any role, any holder; the empty set short-circuits to an empty page), composable with q/statusId/projectId/assigneeId/inboxOfMe, omitted/false = no filtering; session tier — every authenticated reader sees the company queue, not just their own. OBLIGATION LIFECYCLE (#205): a PENDING obligation never outlives the state that makes it actionable — setStatus teardown resolves status CATEGORIES, never seeded ids: any settle into a done/cancelled-category status (seeded or custom) tears the review round down and cancels every PENDING obligation (both roles); any move out of the waiting_answer category cancels PENDING ANSWER obligations; the inbox, badge and awaiting-decision queue therefore never render a settled task
task_assignments(id, task_id cascade, employee_id set null, reason, actor_id, started_at, ended_at) — append-only assignee ledger; current assignee stays denormalized on tasks.assignee_id; every change (create/update/reassign) flows through recordAssignment; derived "X -> Y" activity; recent rows feed the reassign ping-pong loop guard
tasks.parent_task_id -> tasks.id (set null), tasks.pre_block_status — subtask nesting, unlimited depth; children are full tasks (own assignee/runs/reviewers); parent auto-blocks while any child is non-terminal (done or cancelled-category), restoring pre_block_status when all children land terminal — derived, no drift; UNBLOCK RESTORE LAW (2026-10-31, #88): the restore target resolves against task_statuses before the write — an unknown/malformed id falls back to to-do (this write bypasses the setStatus membership guard, so a stale id would re-create a dangling tasks.status — the #62 class), and a working-category target restores to to-do instead (a working status must be backed by a live run; the dispatcher scans ready-category only, so restore-to-doing dead-ended the task — prod 9515f3f8 sat stranded 4+ days after its 2026-10-27 unblock); PARK-ORIGIN RESTORE (2026-11-01, #202): a review park (REVIEW LAW) persists its own origin in tasks.park_from_status in the same write that flips the task to blocked; when every child lands terminal the unblock arm fires for a parked task too — the restore target is the recorded pre-park status, resolved against task_statuses with an unknown-id fallback to in-review (the only park origin), NEVER the to-do demotion (a to-do restore re-enters the ready-category dispatch scan and bypasses the open review round); park origin outranks a stale pre_block_status, both columns clear in the single unblock write, and the restored round's parked reviewer turn re-dispatches (unblock-resume parity); GUARDED GATING WRITE (2026-11-02, #208): both gating flips are single conditional writes — the auto-block guarded on the row not being blocked yet, the unblock restore guarded on the row still being blocked AND on the ORIGIN it read (a statuses.remove re-home rewrites the origin on a blocked row, so an unpinned restore would write the stale target it resolved — a deleted status id, i.e. a ghost task, or the #88 to-do demotion) — each returning the affected row as the sole race arbiter against a concurrent owner move (the status-category resolve ahead of the restore opens an interleave window a manual settle can win); a zero-row result means the concurrent writer owns the outcome: the losing arm appends no activity row, replays no reviewer turn and stops its walk there (the winner propagates parent gating itself — every status write path re-runs refreshParentGating), so a stale read can never resurrect a settled task, stomp a park's origin memory or double-mint the restored turn; the manual status move also clears park_from_status (owner resolution wins); OWNER-MOVE RECORD (2026-11-12, #430): the manual status write and its `status: <from> → <to>` activity row commit in ONE transaction (`tasks.setStatus` is the only writer of that body and every surface — sidebar, list, board drag — rides it), so a landed owner move can never exist without the record the prod watchdog reads to tell an owner move from a machine status write; the transaction takes the ACTOR's user row first (KEY SHARE — the employee-delete path holds that row and then cascades into tasks, so the reverse order deadlocks) and a vanished actor row is a LOST attempt (a clean refusal, never a driver FK error); the teardown/resume side effects run AFTER that commit, so their failure can never erase it; submit is refused while children are open; child briefs carry "This is a subtask of: <parent title>"
task_proposals(id, task_id cascade, run_id cascade, kind: subtasks|reassign, payload jsonb, status: proposed|executed|rejected, decision_note, decided_by, decided_at, created_at) — agent routing proposals read ONLY from the settled run's JSON envelope (its `subtasks`/`reassign` fields — envelope-only routing, 2026-10-26: no [SUBTASKS]/[REASSIGN] text markers, so echoed task content can never route); human confirms via tasks.confirmProposal/rejectProposal — the confirm flow is the single structural writer. AUTO-EXECUTION LAW (2026-10-16): when EVERY routing target of a proposal resolves inside the proposing agent's own supervision chain, the proposal executes immediately at settle (no approval) through the same confirm path; outside-chain targets or unnamed routing still wait for a human, and the ping-pong loop guard still applies (a guarded target stays proposed rather than executing): subtasks are created full (assignee kept when inside the agent's supervision chain, else escalated to the agent's supervisor; unknown names land unassigned), reassigns write through the ledger with a loop guard refusing recent assignees; rejected notes ride the next brief to prevent re-propose loops
seeded statuses add blocked (paused; next: todo) and cancelled (the cancelled-category terminal — abandoned was merged into it; abandonReview lands on cancelled)
tasks page: "Needs my decision" toggle (badge = pending obligations on the current user) filters the list/board to inbox tasks; the company-wide "Awaiting decision" chip (deep link /tasks?awaiting=1, URL synced on toggle) filters to every task holding a pending obligation for anyone, rows and mobile cards badge "Waiting on <holder>" (the pending answer holder; "Review pending" while the task sits in-review with approvers outstanding) and the overview carries a live-count card linking to the same filtered list. DECISION-VISIBILITY LAW (2026-11-07): the "Needs my decision" toggle is URL-backed like the company chip — /tasks?inbox=1 restores it on mount and every toggle writes/clears the param, so the personal queue is linkable and survives reload/share; the app shell's Tasks nav item carries a live count badge of the signed-in user's pending obligations (tasks.inbox items, any role), absent at zero and kept fresh by the TASKS change resource; below lg, where the sidebar is a closed drawer, the same count rides the page navbar as a one-tap link into the queue — a human sees work waiting on them from every page (a collapsed desktop sidebar is icon-only by design — the count returns on expand), the Tasks page's toggle remains the one-click way in, and the badge query never fires while signed out or on the forced-rotation screen (ROTATION LOCK); the digits are decorative (aria-hidden) and the count is announced as words in the Tasks link name, so name-based navigation still reaches the queue. CREATE-AFFORDANCE LAW (#210): the toolbar "New task" entry renders on EVERY view state — List and Board, empty, filtered or not — for every EMPLOYEE-TIER session, so deleting the last task never leaves the tasks surface without a one-step create entry; the List empty-state CTA stays and both may coexist (below the employee tier the entry hides — see Roles & access, Employee-tier render rule #300)
TASK SCOPE LAW (2026-11-06, #339): the tasks list/board accepts ONE optional project scope — `tasks.listPaged` takes `projectId` and AND-composes it with q/statusId/inboxOfMe/awaitingDecision (an unknown id yields an empty page: a filter is not a lookup, never an error); the page reads `?project=<id>` on load and keeps the URL in sync on change (same contract as `?awaiting=1`), the filter bar carries one project select ("All projects" clears it; the select renders whenever the workspace has projects, or any scope is active) and the LIST's empty state names the scoped project in every composed state, phrased relative to whichever filters are active (search / status chip / obligation toggles) instead of claiming the project is empty — the board's per-column placeholders are unchanged; a scope the project list cannot resolve renders as "Unknown project" with the copy's name falling back to "this project"; the URL is normalized on load to the ONE effective scope — the internal NONE_ID sentinel never becomes a scope, and a blank or multi-valued `?project` is rewritten to the resolved single id (or dropped); the New-task editor opened from a scoped list pre-fills its Project with that scope when the scope resolves to a project (clearable; an unknown id never reaches the create payload) and a scoped list's empty-state create entry renders too — creating from the scope lands in the scope; every project row (desktop actions + mobile card) carries a one-click "View tasks" entry to `/tasks?project=<id>` that renders at EVERY session tier (reading tasks is session-tier — only the write trio stays employee-tier); SCOPE-PRESERVING NAVIGATION (2026-11-07, #341): a task link in the list carries the active list state (`project`, `awaiting=1`) onto the detail URL, so the detail page's back link rebuilds the same scoped list, parent/subtask drill-down links keep the scope, and an unscoped detail still returns to bare `/tasks` — opening a task never silently widens or drops the user's scope, and a normalized-away scope (NONE_ID/blank) never reaches a link.
ASSIGNEE SCOPE LAW (2026-11-07, #353): the tasks list/board accepts ONE optional assignee scope — `tasks.listPaged` takes `assigneeId` and AND-composes it with q/statusId/projectId/inboxOfMe/awaitingDecision (an unknown/blank id yields an empty page: a filter is not a lookup, never an error); the page reads `?assignee=<userId>` on load and keeps the URL in sync on change (same contract as `?project=`), and the filter bar carries one assignee select — "Anyone" clears it, "My tasks" is the session user's id (no special token in the URL), employees render through the shared employeeOptions label contract ("Name (AI)" for agents); the LIST's empty state names the assignee filter in every composed state, phrased relative to whichever other filters are active (search / status chip / project scope / obligation toggles) instead of claiming the assignee has no tasks; a scope the employee list cannot resolve renders as "Unknown employee" with the copy falling back to "this assignee", so a stale URL stays clearable; the URL is normalized on load to the ONE effective scope (blank/multi-valued `?assignee` rewritten or dropped; the NONE_ID sentinel never becomes a scope); a task link in the list carries the active assignee scope onto the detail URL (`taskListQueryFrom`), so the detail page's back link rebuilds the same filtered list; session tier — every authenticated reader can filter.
task page Details: assignee / project / status are editable in place (USelect per row on one aligned grid; reassign records the assignment ledger row). STATUS FREEDOM (owner ruling 2026-10-27): manual status is free — the transition graph is advisory, the server nextIds/terminal guards are gone, every surface (sidebar, list, board drag) sets any status; built-in statuses are editable in Statuses manager; blocked transitions = {todo, cancelled}, no self-edge; MEMBERSHIP GUARD (2026-10-30): setStatus resolves the target against task_statuses ids and refuses unknown values ('status does not exist') — tasks.status has no FK by design, so the write path is what keeps dangling legacy strings (dispatch/board ghosts) out; CATEGORY-GATE LAW (2026-11-06, #336): every lifecycle GATE resolves the task's status CATEGORY against task_statuses — the seeded uuids are landing/write targets only, never gate keys (submit and answer already read the category, #265) — so ask, the human verdicts (approve / request-changes / reject), escalate, park, abandon's review-vs-work branch, the terminal late-verdict gate, the waiting-answer hold's in-review re-fire check, unblock-resume after a manual move, the reaper's review-vs-work classification and its work-bounce guard, and the proposal terminal check all treat a custom status exactly like its seeded sibling; a status's category is LOAD-BEARING for every task already sitting in it — an admin category edit re-keys every gate for those tasks (an open review round must be re-homed to an in-review-category status BEFORE its status is re-categorized, or verdicts refuse and the next review settle parks/misses); STATUS-ORIGIN MEMORY LAW (2026-11-12, #432): a machine origin (tasks.pre_block_status / tasks.park_from_status) is a raw id with no FK whose CATEGORY every reader resolves, so a status mutation must never change what a recorded home MEANS nor leave it naming no row — statuses.remove RE-HOMES every recorded reference (both columns, every task row) onto a SURVIVING status of the SAME category inside the delete's own transaction — the target is resolved LIVE by category (lowest position wins, so the seeded built-in in a stock workspace; a frozen id map would re-home into the wrong category after an admin recategorizes a built-in) and must not be the BLOCK STATE itself (by IDENTITY: a home re-homed onto BLOCKED restores the task INTO the block, clears both origins and strands it with no arm left to fire), while 'paused' has NO faithful target at all (any restore into a paused status clears the origin and leaves a row no arm fires on); a TASK_STATUSES MUTATION MUTEX — one transaction-scoped advisory lock taken by both save and remove — serializes every writer of the table, so a category edit can never interleave with a re-home (a save racing the re-home TARGET would otherwise re-categorize a home that just landed) and two same-category removals can never deadlock on each other's target, and the referencing task rows are locked FOR UPDATE so a concurrent gating block waits for the delete; when no faithful target exists the removal REFUSES while a task IN THE BLOCK STATE (by IDENTITY — the only state a gating block/park ever writes, and the state every GATING arm fires on) records it, and the BLOCK STATE'S OWN CATEGORY IS FROZEN: statuses.save refuses any category change on it except back to 'paused' (name / colour / position stay editable, and a save that leaves the category untouched still lands, so even a drifted row can be renamed; the freeze is ONE-WAY so a workspace drifted on a pre-guard image repairs itself in-product), because the review-flow readers resolve the paused CATEGORY — Blocked→ready re-keys every blocked row into the ready dispatch scan, Blocked→done makes them all terminal, and either blinds both probe block arms, so a recategorized block state would turn every recorded home 'inert' at once, and CLEARS inert references on every other row (#427 egress leftovers mean nothing to any reader and must not make a status undeletable forever); the repair runs AFTER the delete in the SAME transaction and UNCONDITIONALLY (its UPDATE WHERE catches a block that committed inside the refs-read→delete window), a post-repair re-read rolls the whole delete back if any row still names the removed id (a task moved into the status, or a STALE gating write that captured its home before its conditional write, committed inside the window), the write HOLDS updated_at BACK (a bumped stamp would miss an in-flight settle flip's CAS — the very strand this law removes — and mask the #430 wedge discriminator), and after the commit every BLOCKED row the repair wrote is re-gated best-effort onto its NEW home (the repair's RETURNING is the set; an INERT origin on a live row is re-homed WITHOUT a re-gate — re-deriving a live row's gate would BLOCK it when it owns open children, silently undoing a manual unblock — and the restore that raced the delete lost its CAS on the pinned origin, so nothing else would revisit it); statuses.save REFUSES a CATEGORY change while a task in the block state records that status as its home (name / colour / position edits stay free, and stale references on any other row never gate an edit); both guards are read-then-write checks, NOT locks — a task moved into the status after the repair statement commits is the pre-existing ghost-task race the in-use check above already carries, and the probe's dangling arm sees it; the other half of that window (a gating BLOCK landing inside a save's homes read, leaving a blocked task on a RE-KEYED home) has no arm yet — filed as #435; without the re-home the home stops resolving entirely: the settle flip's machine-home term stops matching, the round closes with NO task write, and the restore falls an unknown BLOCK home back to to-do (a park home falls back to in-review); a guarded write whose predicate must pin the row it read arbitrates on THAT status id (eq(tasks.status, <read id>)), never the seeded constant — a seeded-id gate on a custom in-review status is a live dead end (the review box renders by category, every verdict 400s; a park silently misses and the round wedges). RUN LOCK (owner ruling 2026-10-27): while a run is live the running agent owns the task — status AND assignee edits are rejected server-side and disabled in the UI. STOP-RUN VERB (2026-11-02, #229): the lock's human half — `tasks.stop` settles the task's live run STOPPED: it aborts the open ACP turn over the runner's stream (session/cancel, then the cancel-grace kill), flips the row with ONE guarded write (status RUNNING → STOPPED + finished_at + a `[run] stopped` line appended to the output; the CAS is the sole race arbiter against the turn's own settle — a turn that settles first keeps its verdict), publishes the change event, and thereby releases the RUN LOCK. A stop is NOT a verdict: the TASK row is untouched (it stays in its status — cancel/dispatch re-render per their own gates, the liveness sweep eventually recovers a doing row exactly as it would for any settle), and the in-flight execution's finish path skips every settle side effect for a stop-settled run (no message rewrite, no bounce, no park). Idempotent: a second stop, or a stop when no run is live, returns ok and touches nothing. A stopped REVIEW turn is a human intervention, never auto-re-fired: the round parks decision-class (no re-arm ladder — re-firing a stopped reviewer fights the stop) and owner unblock re-dispatches the parked turn. Reviewers are a multi-select in TaskEditorModal (explicit reviewers only — see the review law)
task page = one conversation thread (owner rulings 2026-10-26): the main column is the chat timeline (brief bubble, agent run turns showing the settled result body with expandable raw input = the exact brief + raw output = the full transcript + collected deliverables, activity notes) loaded via tasks.threadList (GET + change events); the composer is ONE state-aware Send button (COMPOSER LAW, owner ruling 2026-10-27): agent running → submitting STEERS the live run (a second session/prompt injected on the open ACP stream via the onSessionOpen hook; steerRun tri-state steered|refused|stopped, a live run always blocks a second dispatch); agent stopped → submitting DISPATCHES the run (needs an AI assignee + a non-terminal, non-in-review status; steer-or-dispatch decided in tasks.note, which returns the outcome); NOTE-EGRESS ROUND TEARDOWN (2026-11-13, #443): a dispatch flip is an egress from whatever the task was — including a review park (BLOCKED with `park_from_status` set, its round's reviewer row PENDING, the turn stopped) — so the SAME transaction that lands the status resolves every open round: PENDING rows become `superseded` and approval obligations cancel (the abandon / terminal-settle teardown, task-wide because a ready task must own no live round), because the send returns the task to work and the parked round's verdict would judge work the agent is about to redo, while the round left behind is reachable by NO sweep (the stalled-review and lost-settle sweeps require review-flow ownership) and its verdict is discarded silently; the follow-up submit opens the next round cleanly. A manual move out of review keeps its declared behavior (it strands no machine turn and leaves the round's PENDING rows as declared debris — the probe's manual-freedom discriminator keys on its owner-move record); COMPOSER HINT LAW (2026-11-03, #265): every composer surface (task page + the /tasks workflow drawer) renders ONE send hint that mirrors the send verb's server rule exactly — steering wording while a run is live, answer wording while waiting-answer FOR the question's current holder (there the send IS the answer verb and an AI assignee's turn re-arms; other viewers read neutral send wording — the verb's gate is chain membership), dispatch wording wherever the send would start an agent turn (any other non-terminal, non-in-review category with an AI assignee and no pending dispatch backoff — the row's retry banner names the ladder; the wording promises the verb, not every queue state: a full agent cap or a steer refusal surface through the send's outcome copy instead (a pending backoff suppresses the wording outright — the row's retry banner names the ladder)), thread-only wording otherwise; an unsettled run feed is UNKNOWN run state (the verbs' convention): the hint promises nothing (neutral send wording) rather than a claim it cannot back (#265 r1) — and the send button's accessible name carries the same wording, so no state where the copy promises thread-only can dispatch; while waiting-answer the send routes to the answer verb; review verdicts live in a GitHub-style TaskReviewBox rendered only while in-review (optional note rides Approve / Request changes / Reject); Ask is an AGENT verb only (envelope question) — there is no human Ask button; sidebar workflow verbs are contextual per state and render ONLY where the server accepts them (Submit for review only for a human assignee in a working status — AI assignees submit via the envelope; Abandon in working states; Forward only while the task is waiting-answer AND the viewer is the current answer holder — the pending answer obligation's holder — hidden in working states and for non-holders; Dispatch now only for an AI assignee in a ready-category status with no live run — the ready-category subset of the composer's stopped-state dispatch surfaced as an explicit verb — never while a run is live or the status left the ready category; Stop run only while a run is live (#229 — it renders exactly where `tasks.stop` settles and is gone the moment the run feed shows settled: one click, the confirm states the run ends while the task keeps its status)); DISPATCH RENDER-PARITY LAW (2026-11-02, #209): that gate binds EVERY surface rendering the verb — the /tasks workflow drawer computes the SAME dispatchReady from its own run feed (AI assignee + ready category + no live run; an unsettled feed means unknown run state and renders nothing rather than a dead verb) — the drawer can never offer a click the server's requireDispatchable refuses, let alone one under a visibly streaming run card); VERB RENDER-PARITY binds cancellation too (#223, 2026-11-02): cancelReady = work-category status AND the viewer is the owner/assignee AND no live run (the server's abandon refuses over a running run — RUN LOCK), each surface folding its own run feed's settled state (an unsettled feed is unknown, never idle → no verb, no armed confirm), and the confirm copy states only what actually happens: the task ends and no further run can be dispatched; the verbs live ON the task page (desktop aside + the mobile info sheet, one click each) — the /tasks workflow drawer is a second surface for the same ladder, never a required round-trip (#177)
dispatcher STALE-JOB LAW (2026-10-16): queued dispatch jobs may be stale (duplicates stacked while the worker was busy); the worker re-checks the task is in a ready-category status before dispatching and SKIPS ineligible jobs silently (no re-run, no retry storm, no flip back to doing), and dispatch enqueues carry jobId=taskId with removeOnComplete so duplicates cannot stack while a job waits/runs while re-dispatch after completion still works. LIVENESS SWEEP (2026-10-31, #88): the dispatcher tick also returns working-category AI-assigned tasks whose newest run is settled (no RUNNING run) — or that have no runs at all — for more than 15 minutes back to to-do; fail_streak and dispatch_after are untouched (liveness repair, not failure) and human-assigned tasks are exempt (manual status freedom); a working status is backed by a live run or it bounces — covering unblock relics, missed status remaps and settle-path regressions; the 10-min probe alerts on the same shape past 25 min (i.e. only if the sweep itself stopped working). REAPER LIVENESS LAW (2026-11-01, #147): the reaper's own liveness is stated and verified — a failed reaper sweep logs a rate-limited warning (at most one per 5 min) instead of returning silently, and boot starts the dispatcher through a retry loop (fixed 30s machine interval, 24/7) that logs every failed attempt loudly and stops only when the queue is reachable or the dispatcher is intentionally disabled (TANDEM_NO_DISPATCHER) — a redis blip at restart can no longer leave the server serving with no dispatcher and no reaper; the external 10-min watchdog mirrors the reaper's WHERE (RUNNING past the run-timeout SETTING + 5 min margin, never a fixed interval) and files ghost rows on two consecutive positives deduped by run-id fingerprint set. dispatcher: scans ready-category statuses; PER-AGENT BullMQ queues (tandem-dispatch-<agentId>), each worker concurrency = tasksPerAgent (Settings page, default 1, zod 1..32, workers re-sync on settings.update without a redeploy AND on the AI roster itself changing — employee create/remove triggers the same resync, so a runtime-minted agent's first dispatch executes without a redeploy or settings save; WORKER-SYNC COALESCING (2026-11-03, #290): syncDispatchWorkers keeps at most ONE execution in flight per process — concurrent callers (per-tick detached resync, settings update, employee create/update, boot) coalesce onto the same promise and the roster re-check stays authoritative after it lands, so overlapping syncs can never mint duplicate per-agent workers (2×cap execution, unreachable by any later sync); a caller whose intent post-dates the in-flight read (settings cap / employee roster change) chains ONE follow-up execution after the in-flight sync lands, so the new cap/roster applies immediately instead of waiting for the next trigger; WORKER-ROSTER LAW (2026-11-01, #177): sync ran at boot + settings.update only, so an agent created at runtime had no worker and every one of its dispatches wedged — run row stuck RUNNING until the reaper, then an endless backoff loop) — agents always run in parallel with each other, one agent runs up to N tasks at once; NO TIME-AWARE THROTTLING (2026-10-31, owner ruling — the 2026-10-31 PEAK CADENCE experiment is REVERTED): the effective per-agent cap is `tasks_per_agent` at every hour of every day — no peak windows, no multipliers, no wall-clock logic anywhere in the dispatch path. Agents run full speed 24/7. run output kept in full (no tail truncation); no settle activity note — the run card's status pill is the verdict. DISPATCH-SCAN BOUNDING LAW (2026-10-31, #130): the 5s dispatcher tick is never an unbounded table scan — the eligible-task scan pushes ready-category + AI-assignee AND the elapsed-backoff predicate into the SQL WHERE (status IN ready AND assignee IN ai AND (dispatch_after IS NULL OR dispatch_after <= now), created_at order preserved) and is LIMIT-bounded to tasks_per_agent × active agents + a fixed margin (oldest first) — the backoff filter is SQL-side and the tick never re-reads the whole ready∩AI backlog (#176) and fetches per-agent live-run counts in ONE GROUP BY query (never a serialized COUNT per candidate); the liveness sweep leg is equally bounded (2026-11-02, #225): ONE statement per tick — the newest run per working candidate arrives via a LATERAL join (task_runs⋈task_messages, newest started_at first), the no-live-run and idle-past-grace predicates ride the SQL WHERE, and the read is LIMIT-bounded by a fixed sweep margin (relics beyond the bound bounce on the following tick) — the bounce loop stays JS over the returned rows and the sweep's per-tick cost is O(bound), never O(backlog), even under a stuck-relic backlog; the reaper sweep selects NO transcript columns (id/started_at + the task-id join only — the timed-out marker is appended inside the UPDATE's SQL against task_runs.output, never by re-reading the transcript); hot-path indexes: tasks(parent_task_id) (gating walks children on every status change), tasks(created_at, id) (every list shape sorts newest-first — the snapshot and listPaged top-N) and task_runs(status) (the reaper's RUNNING sweep every tick). RUN-TRANSCRIPT LAW (2026-10-31, #130 slice 2): a run's transcript text — the streamed `output` and the frozen `prompt` — never rides list snapshots; `tasks.runsList`/`tasks.runs`/`tasks.threadList`/`tasks.thread` payloads carry `output` ONLY while that run is `RUNNING` (the live stream surface) plus `hasOutput`/`hasPrompt` booleans, and every settled transcript and every prompt travels exclusively through the on-demand `tasks.runTranscript` procedure (`{runId}` → `{id, output, prompt}`, NOT_FOUND on an unknown id) — UI folds fetch the transcript on first open and keep it cached for the view, and the workflow drawer's always-visible run cards fetch each displayed run's transcript once per open drawer (same cache); server-internal readers (brief builder, runner settle, reaper marker) keep their own selects and are unaffected. THREAD BOUNDING LAW (2026-11-01, #175): thread payloads are bounded, never fetch-alls — `tasks.threadList`/`tasks.thread` return `{items, hasMore}` where `items` is the NEWEST up to 200 visible thread items (status rows and echo notes excluded before the cap) and `hasMore` is true iff older raw messages exist beyond the returned window; older history travels exclusively through the on-demand `tasks.threadOlderPage` procedure (`{taskId, before: {createdAt, id}}` cursor = the oldest held item → same `{items, hasMore}` envelope carrying the previous page of visible items, empty `items` + `hasMore:false` at the thread's start); echo-note dedupe stays window-local by construction (a run always precedes its own echo in (createdAt,id) order, so a cursor boundary can never split an echo from its run); the thread's collected-outputs query is scoped to the task (a `task_id` predicate riding the `task_attachments_task_idx` index — the query plan must use it) and never scans other tasks' attachments, and the `run_id IS NULL` arm is gone because output attachments always carry their run (settleAttachments is the only output writer; user uploads are kind `input` with no run); `tasks.runsList`/`tasks.runs` cap at the newest 50 runs of the task. RETENTION LAW (2026-11-06, #266): the dispatcher tick carries a daily retention leg — settings-stamp throttled (`retention_last_run` epoch ms, one run per 24h, stamped only on a full pass; `retention_last_attempt` is stamped at every pass start so 'runs but never completes' is observable; on failure a rate-limited warn and a 15-minute retry backoff — the blast radius is one batch per backoff, never one per tick) and fault-isolated like every tick leg — that bounds unbounded storage — leg 1 keeps EVERY run row for audit (only the transcript text is cleared); legs 2/3 delete state that is no longer actionable: (1) settled runs (`status <> 'RUNNING'`, `finished_at < now()-horizon`) of TERMINAL-category tasks get their transcript blanked in place (`output=''`, `prompt=NULL` — the row, its identity and audit metadata stay; `hasOutput`/`hasPrompt` collapse to false so the fold honestly shows nothing to fetch, and `tasks.runTranscript` returns the blank body); (2) non-PENDING obligations (`resolved_at < now()-horizon`) are deleted UNLESS their task still carries a PENDING obligation (a live approval round still displays its resolved rows — deleting them would regress the approved tally); (3) expired auth sessions (`expires_at < now()`) are deleted. Every leg is LIMIT-bounded (oldest-first batch per day-tick, relics beyond the bound drain on following days) and the scans push category/age predicates into the SQL WHERE — never a fetch-all. Horizon = 30d. PENDING obligations, transcripts of runs on non-terminal tasks, and live sessions are NEVER touched. The prod watchdog is margin-keyed on the MECHANISM, never on raw state, in two arms: (a) the `retention_last_attempt` stamp absent past a 1h post-deploy grace or older than 25h = the leg is not running (absent with a pre-retention image stays silent, version-gated, heartbeat-style); (b) attempts fresh but `retention_last_run` absent or older than 25h = the leg runs but never completes a pass. A pre-retention image stays silent; a wired leg that never once succeeds alarms. The past-horizon retained count is operational data, never an alarm: the drain bounds ~500 runs/day, so a backlog larger than one day's batch legally drains over several days, and inflow permanently above the batch accumulates as a capacity decision (raise the batch or shorten the horizon), not an alert. SNAPSHOT-SLIMMING LAW (2026-11-01, #130 slice 3): list-time obligation reads are bounded and column-projected — the per-snapshot approvals batch resolves each task's LATEST approval round in SQL (max(created_at) per task over role=approval rows, joined back for that round only) and projects only the round-decision columns (task_id, employee_id, status); the open-obligations batch projects only the columns its holders/approvers maps consume; no list payload path loads full obligation rows or earlier rounds (wire unchanged: reviewApprovals = the latest round's fulfilled approver ids, [] when that round holds a cancelled row). The task description body never rides list payloads — tasks.list/listPaged rows carry NO description, and the body travels on the by-id read and through the on-demand tasks.getDescription procedure ({taskId} -> {id, description}, NOT_FOUND on an unknown task) that the editor modal keeps fetching on open (the RUN-TRANSCRIPT LAW's on-demand pattern). BY-ID READ LAW (2026-11-02, #220): a surface that renders exactly ONE task reads it through `tasks.get` ({taskId} -> the single-row payload: every list-row column PLUS the description body, NOT_FOUND on an unknown id) — never by subscribing to a whole-list snapshot and filtering client-side; tasks.list stays the whole-board snapshot surface and tasks.listPaged the paged/searched surface for many-task views (board, table); tasks.get is a session-tier live-invalidated GET keyed on the TASKS resource, so a task page refetches ONE row per change event instead of the full table. NO-SILENT-WIPE GUARD (#145): the editor modal never derives a description patch from an unresolved or failed on-open fetch — while the getDescription fetch is unsettled or has failed, an unedited save transmits NO description field at all (the update patch omits it and the stored body survives) and a failed fetch says so in the modal; the field joins the update only once the fetch has resolved or the user authored field content this session, and explicit clearing still saves '' after a resolved fetch. DISPATCH CLAIM LAW (2026-11-01, #162): the dispatch claim is ONE conditional flip of the task row — an UPDATE guarded by the task's status still being in a ready-category, whose RETURNING is the sole arbiter of the race between the scan tick, the direct paths (addNote auto-dispatch) and a manual dispatch; exactly one concurrent claimant wins. A loser aborts PRE-INSERT: no run row, no dispatch note, no thread turn, no doing flip, no per-agent job, no cap consumption — stale-duplicate semantics, a quiet no-op (the scan simply looks for the next eligible task). CLAIM-RUN ATOMICITY LAW (2026-11-10, #406): the claim, the run's thread message and the RUNNING run row commit in ONE transaction, so a dispatch claim can never be observed without its live run row — the composer's liveness gate (steer / running-run reads) and the per-agent cap both read task_runs and would otherwise see the claim as an idle task (a working status with no live run stays legal only in the cases the LIVENESS SWEEP exists for: a manual status move, a stopped run, a settle); the pre-#406 window let a note flip the claimed row back to to-do and dispatch a SECOND run whose work was then discarded. Every read (plan, brief, verdicts-so-far) lands BEFORE the transaction: a work dispatch's failure there flips NOTHING (no claim state for the sweep to heal) and only PUSHES the task's next scan attempt later (dispatch_after at least + 60s, never shortening a longer failure-ladder backoff, no status change; a review turn defers nothing — it has no scan attempt), so one unplannable task can never sit at the head of the one-candidate-per-tick scan and stall every agent; the loser rolls back with zero rows, a claiming dispatch key-shares the employee row its inserts FK-reference in ONE statement BEFORE the tasks row (the #400 lock order — a claim held across the FK-checking inserts would invert it and deadlock, 40P01), and the claim predicate pins the assignee the plan was built for — a reassignment in the plan→claim window loses the claim as a stale duplicate instead of dispatching the old assignee. GUARD-SETTLE LAW (same origin, #162): a runner guard that refuses to execute a run — the stale-job guard (row state changed while the attempt sat in backoff) or the superseded-intent guard (a newer run of the task exists) — settles a still-RUNNING row FIRST (FAILED + finished_at + a [dispatch] reason appended to the row output; the TASK is untouched: the winning intent owns the task's status). A rejected run row may never linger RUNNING for the reaper: until the reaper fires it counts toward the agent's per-agent cap, and the agent silently claims nothing. TICK-ISOLATION LAW (2026-11-01, #172): every dispatcher tick leg is fault-isolated — scanOnce catches its own errors INCLUDING the find-eligible DB reads (rate-limited warn, one per 5 min) and returns false instead of rejecting; the interval's `void` call sites lean on that catch as a contract, and on the bun runtime an unhandled tick rejection terminates the whole server (UI, workers and every in-flight run with it). DISPATCHER HEARTBEAT (same origin): each tick stamps settings key `dispatcher_last_tick` (epoch ms, throttled to one write per 30s, best-effort with its own catch); the prod probe alerts when the key exists and is older than 120s — a missing key means a pre-heartbeat image and stays silent
dispatch = ACP v1 (Agent Client Protocol): the runner spawns the employee's ACP executable (required, shell-word-validated, e.g. `hermes acp`) over SSH stdio — env blob byte-count framed on stdin ahead of the JSON-RPC stream; initialize advertises NO client capabilities (no fs/terminal — agents never touch Tandem); the ACP session lives on the run row (task_runs.session_id): the first turn opens session/new, later turns by the SAME employee resume their latest run's session on the task (answer, review, re-dispatch), the agent process is killed after every turn; sessions are per task×employee — a reviewer's turn never resumes the assignee's session; permission requests are auto-allowed (headless parity) and logged; session/update streams live into the run log (agent_message_chunk text is line-coalesced — one log line per source newline, pending remainder flushed at turn end, force-flush at 400 chars; a full agent_message logs once and only when nothing streamed); SSE-AMPLIFICATION LAW (#253, 2026-11-02): RUNS change events publish on run lifecycle transitions (dispatch start, settle/finish, stop) and at most ONCE per publish heartbeat while streaming (TANDEM_RUN_PUBLISH_MS, default 3000ms) — never per DB-append flush; streamed output still lands on the run row at the flush cadence (TANDEM_RUN_FLUSH_MS — durability unchanged), while the SSE feed re-emits task snapshots at heartbeat cadence, so the transcript payload ships bounded per viewer regardless of output size or flush frequency; STEER-HOOK LIFECYCLE (2026-11-01, #161): the per-run mid-turn steer hook (registered via the ACP turn's onSessionOpen — a closure over the open connection + bridged streams) is TRANSIENT by contract: it exists only while the run's turn is live and is deleted when the run's execution exits (every terminal path through executeRun — done, failed, retry-throw — passes the single cleanup point exactly once); a settled run retains no steer closure, so a long-lived server never pins one ACP client context per finished run (unbounded growth = bug); agent run timeout: Settings-page value `run_timeout_ms` (default 30 min, min 1 min) — the ACP turn is cancelled at the cap and the reaper uses the same value; no env var; SETUP-KILL LAW (2026-11-03, #284 #285): the dead-wire promise carries a rejection handler from CREATION (the per-race handlers attach only after session setup — a wire death during initialize/resume/session-new must never raise an unhandledRejection and kill the whole bun process), the wire teardown is effective from the moment the stream is registered, and EVERY setup await races the dead-wire promise so the session-setup timeout genuinely kills a silent agent and settles the turn FAILED (the worker slot frees; the turn never hangs unraced to its timeout); the exact prompt (brief) is persisted on the run row before the turn starts so the task page can show the input alongside the output; brief assembly is layered (user law 2026-10-16): COMPANY (settings-page companyPrompt) -> PROJECT (projects.prompt of the task's project) -> employee standing instructions -> TASK; empty layers are omitted entirely; the run's persisted prompt shows the exact assembled brief. RELAY BRIEF LAW (owner ruling 2026-10-26): the full layered brief ships only on the reader's FIRST run of a task; every later prompt is a conversation relay, not a re-brief — org header + CONTINUATION line (fresh-session hint) + ONLY task_messages newer than the reader's own last finished run + attachments + contract: other agents' turns relay settled as kind result, the reader's own turns are skipped (they live in its session), STATUS bookkeeping never ships; prompt message lines ship WHOLE (never truncated); OUTPUT CONTRACT (the one JSON envelope line) and the DELIVERABLES out-dir ride EVERY prompt. REVIEW LAW (FINAL SPEC v2, owner-locked 2026-10-29): EXPLICIT reviewers only — the org supervisor is NOT a default quality gate; a submit with no reviewers completes immediately. REVIEWER EXISTENCE (#361): the roster is existence-checked at both ends — tasks.create/tasks.update refuse a reviewer id that names no existing user with BAD_REQUEST ('reviewer does not exist'), EXCEPT ids already stored on the task being updated in canonical uuid spelling (tasks.reviewers is a text[] with no FK, so a former employee's id must not make a legacy task un-editable; a write may keep or drop it — a stored value outside the canonical shape cannot be re-submitted under the ID-SHAPE write law, but it can be removed); submit re-checks the roster before the round opens — stored values canonicalize to their uuid form first (braced and hyphenless spellings included), reviewers that no longer name a user (deleted after being set, or values that never named one) are dropped with a thread note written only when the submit actually lands, the round opens for the survivors, and zero survivors closes any round left open from an earlier submit then completes the task exactly as if no reviewer were set, so a deleted employee can never wedge submit on task_reviews' reviewer FK: the round open re-reads the surviving reviewer rows FOR KEY SHARE inside the same transaction that inserts the round's rows and their approval obligations (#364), so an employee delete either commits before that lock — the reviewer drops out of the round exactly like the pre-check path, and a round left with no reviewer at all completes the task exactly as if none were set — or it blocks until the round commits and then nulls the FK into a non-vote; the round open itself can no longer raise a foreign-key failure on the reviewer FK, a delete landing after the commit is that non-vote, and one racing the review turn's own dispatch mint (the run/message rows carry the reviewer's id) at worst fails that one TURN — the round is already committed, so the submit lands and the round parks rearmable, never a wedge (the task row is a separate FK: a task deleted under the round open refuses that submit, and the task is gone — pre-existing). With reviewers the task parks in-review with one approval obligation + a pending task_reviews row per reviewer per round (the round's rows carry `result_body` = the submitted result being judged, written at round open; review turns re-armed by an answer or unblock replay it — the retired task_activity archive is gone); row statuses: pending -> approved | rejected | request_change, plus escalated | superseded (audit-only, never count). AI reviewers get a review TURN on the SAME task — a run row by them under their own session (never the assignee's), never a subtask, and reviews are never re-reviewed. SEQUENTIAL (owner ruling 2026-10-29): ONE AI review turn in flight per task; a verdict's settle path LAZY-MINTS the next pending reviewer's run onto their per-agent queue — Redis holds zero waiting state (BullMQ = execution bus + retry ladder only; PARKS ARE NOT STORED ANYWHERE: park = no job + existing status/rows describing why). Later reviewers' briefs carry VERDICTS SO FAR (current round's decided verdicts, always). Review brief = the ONE buildBrief composer in review mode (org -> COMPANY -> TASK UNDER REVIEW -> SUBMITTED RESULT -> verdicts-so-far -> relayed activity -> collected submission attachments as evidence -> review contract; no DELIVERABLES/out-dir) — the hand-rolled reviewBrief is deleted. VERDICT-LESS CORRECTION (2026-11-03, #276): the verdict-less settle path's one bounded re-dispatch mints the reviewer's retry turn with a CORRECTION block in its review brief (and NEVER on any first-turn brief): the block states the previous turn produced no valid verdict envelope, that the final line of the response MUST be the verdict JSON envelope exactly as the review contract specced it, and that incomplete verification must ride request_change (carrying what is unresolved) instead of prose; the retry TARGETS the verdict-less reviewer's own pending row (row-order ties must never hand it to another reviewer, and a target row no longer pending mints nothing — the round moved on); the re-dispatch bound is PER ROUND and binds to the round the run was DISPATCHED for (the SETTLING run's start; the AI verdict write binds with the same `at` — a stale settle must never touch a newer round's row or state machine): the bound counts the reviewer's COMPLETED (DONE) turns in that round BEFORE the settling run — a reaped/failed turn is not a verdict-less attempt and never consumes the corrected retry, and a lifetime count would deny returning reviewers their retry from their second round onward; a settle for a round older than the current one is a quiet no-op (the live round owns progression), and a settle with NO row for its dispatched round is an anomaly that parks decision-class instead of re-dispatching (no correction block may attach to a round the reviewer has no row in); the park after the bounded re-dispatch is unchanged (its note names 'review finished without a verdict after a re-dispatch'), and the 10-min watchdog alerts when verdict-less parks (task_messages bodies matching '%finished without a verdict after a re-dispatch%') reach 2 in 24h — the review-contract compliance signal. Envelope (STRICT, review vocabulary): {"kind": "approved"|"rejected"|"request_change"|"escalate", body} — identity-mapped onto row statuses; legacy result/blocked kinds parse as VERDICT-LESS. END-OF-ROUND MATRIX (round settles only after the LAST verdict — a request_change never closes the round early): all approved -> done; all rejected -> cancelled (AI-only rounds included — option A); any request_change or split vote -> task back to ready, notes riding the next brief; resubmission opens round+1 from the task's reviewer roster. Humans and AI are one currency. REVIEWER REMOVAL (#365, 2026-11-08): a PENDING review row whose reviewer no longer exists — the employee was deleted after the round minted the row, so the FK nulls reviewer_id — is a NON-VOTE by construction: it never counts as live (openRoundLive ignores it), it never blocks a settle, and the next settle supersedes it; removing an employee captures (read-only) their pending review rows and their own pending approval obligations BEFORE the delete, then only AFTER the delete commits DROPS those obligations by id (deleted, never cancelled — a cancelled row reads as a dead round to the approver tally), notes those rows, and settles every affected round plus any leftover void row — a round left with NO live voter settles by the normal matrix without the verdict that can never arrive: every remaining decided row approved -> done, every rejected -> cancelled, otherwise the task returns to the assignee (the flip is the FIRST write and pins the status + updatedAt it read, so a concurrent settle/move wins and a lost flip leaves the void row — the machine signature — intact for the next trigger; a terminal settle supersedes every pending row in every round; the void-row signature is the discriminator — a legal manual move to in-review over an already-decided round carries no pending row and is never stomped; and a manual REOPEN out of a done/cancelled status is always the owner's call — it is never auto-settled back by the matrix). REVIEWER TURN REMOVAL (#370/#371, 2026-11-09): removing an employee neutralizes their RUNNING REVIEW turns — a live run on a task currently in an in_review-category status that carries a PENDING review row naming that reviewer; the ids are captured read-only immediately BEFORE the user delete (after the OAuth revoke; a WORK run — the working-category shape — is deliberately left to settle normally so its bounce arm still returns an assignee-less doing task to todo) and each row is settled STOPPED by the same guarded CAS as the stop verb AFTER it commits (the in-flight turn then skips every settle side effect — no park, no bounce, no message rewrite; the run-row CAS still arbitrates against the turn's own settle, and a turn that settled before the delete began keeps its verdict when its review row still binds — a row the delete already voided is a non-vote and the round resumes), so a deleted reviewer's late turn can never park a round it no longer owns; every review settle path that still carries the reviewer identity and would park (no-row anomaly, verdict-settle throw, FAILED turn, verdict-less after its re-dispatch, escalation stalled) checks the reviewer still exists first — the removal owns a deleted reviewer's round, so that path resumes the queue (the departing turn is done, the task-wide mint guard no longer suppresses the next reviewer) instead of parking, including a turn that settled after the removal's one-shot capture (a mint landing in the capture→delete window): its late settle is the recovery point (the anomaly park stays for a reviewer that still exists; a RUN row the reaper finds whose identity the FK already nulled parks REARMABLE as today when it is the task's latest run (the ladder restores the round; a non-latest orphan is swept FAILED without disturbing a newer round)). A removal that voids or decides a reviewer's row re-mints the sequential queue: a task still in an in_review-category status with a live PENDING reviewer gets the next AI turn dispatched (one dispatch per affected task, fault-isolated) — and the mint is TASK-WIDE sequential under a per-task mint lock in this server process (single-container deployment; the RUNNING read still narrows the cross-replica window): nothing dispatches while ANY run of the task is RUNNING and concurrent triggers on one task cannot double-mint within the process (the normal verdict chain is unaffected because a settling run is DONE before its settle mints; a verdict-less CORRECTION caller that loses the mint lock PARKS that reviewer's intent for the round its settle was dispatched for, synchronously with the lock check, instead of double-running — the in-flight mint CARRIES it when its dispatch decision is for that SAME reviewer's current-round pending row (#380), so the retry rides the very turn that beat it whenever the intent lands before that decision; the intent is PARKED BEFORE any await, so every guard that defers the mint (the lock, the mint gate, a live run) and every throw inside the mint leaves the retry on record for that reviewer's next mint — a park restore, the answer's return or an unblock resume, never another reviewer's turn — and the failure's re-arm ladder re-fires WITH the block; the carry is round-scoped (a correction must name its settle round; a round-less or stale-round correction mints nothing) so a CORRECTION block cannot ride a new round's first-turn brief (the mint's own round read narrows the direct caller's window — a review turn takes no DB claim, #401)) — while boot re-runs the same arm for any current-round void row left by a removal that crashed between the delete and the resume: a review-category orphan RUNNING row with the FK-nulled employee_id is settled STOPPED first (no live execution owns it; a work-category run is never touched), then the resume mints, so a reviewer deleted mid-turn never leaves a live round with nothing in flight; a human-only or settled task mints nothing. ANSWER-ROLE REMOVAL (#369, 2026-11-08): removing an employee who holds a PENDING ANSWER obligation captures those obligations read-only BEFORE the delete and CANCELS them by id only AFTER it commits (a cancelled answer obligation is audit-only — no tally reads it, unlike approvals); every affected task still in a waiting_answer-category status with NO pending ANSWER holder left returns to its flow instead of stranding — a review round with ANY pending row lands back in-review (a live round's reviewer turn re-fires, a round left with only void rows settles by the normal matrix), otherwise the task returns to todo, clears the question chain and re-gates its parents (todo/blocked per the gating law) — the return flip pins the status + updatedAt it read (a concurrent settle/move wins and the winner owns the outcome) and the thread notes the removal once; a task whose only ANSWER obligation has a NULL holder is the machine signature of a removal that crashed between delete and settle — the boot heal and any later removal re-run the same return arm, so no waiting-answer task outlives its holder (the company awaiting-decision queue never counts a task nothing can act on); a BLOCKED task is SUSPENDED, not settled — the answer arm never cancels its orphan row (its pre_block/park origin may be the waiting-answer status the unblock restores, and the unblocked task's next sweep returns it). Every path that restores a parked round (manual unblock, parent-gating restore, park re-arm) re-fires only a LIVE round and settles an extinguished one instead, and the AUTOMATIC restores (parent gating, park re-arm) act only on a LADDER-OWNED park (park_rearm_after set): such a restore re-fires its turn, while a DECISION-class park and a FINAL (exhausted-ladder) park are never dissolved or auto-fired by an automatic restore — the row stays blocked for the owner (#419); a removal-driven or boot-driven terminal settle re-gates the settled task's parents; and boot re-settles any leftover void round (a removal that crashed between the delete and the settle). ESCALATE = referral, never settles: body "escalate to <name> for reviewing — <why>"; the system validates the target is up-chain of the escalator (never the assignee — self-review — never self, never an existing round reviewer; supervisor==assignee is skipped walking up; an unparseable/invalid target falls back to the direct supervisor) and MUTATES THE TASK'S REVIEWER ROSTER (escalator out, supervisor in — one source of truth); escalator's row -> escalated, fresh PENDING row same round, obligations move — the escalator's row flip is a CAS on status=pending (#260 sibling, #283): a verdict or teardown that won the row between the gate read and the flip makes the escalation refuse (0-row miss, nothing minted — no roster mutation, no target row, no obligation; a settled task never gains a phantom reviewer); a settle landing inside the mint window itself is self-healed (#292 r2): the freshly minted target row supersedes and its approval obligation cancels via the standard teardown and the roster reverts — gated on the task being in a done/cancelled category (a parked-but-live round is never healed, #292 r3) — the settled task keeps no phantom reviewer; jury shrink accepted (the stand-in carries the full vote); escalation consumes the reviewer's turn and never loops (up-chain only, owner at top). ESCALATE IS AI-REVIEWER ONLY (owner ruling 2026-10-29): humans can never submit an escalate review — the review box carries no escalate verb and the router exposes no human escalate procedure; a human reviewer who cannot judge reassigns or forwards the task instead. PARKS (the round cannot progress without a human: escalation with no eligible target, verdict-less review after its one bounded re-dispatch, access-missing escalation, FAILED REVIEW TURN (2026-11-01, #199): the reviewer's run settles FAILED — post-turn error or exhausted transport retries — the reaper times a review turn out, a review verdict's settle throws, or the review turn's dispatch mint fails — ROUND-OPEN EXCEPTION (#282, re-homed by #394): the round open and the in-review flip are one transaction, so a failed open writes NOTHING and the submit fails with the error surfaced on a task that never left its working status — there is no half-minted round to tear down; the reviewer turn is dispatched only AFTER that transaction commits, so a dispatch mint failure parks the round REARMABLE (the task is already in-review) and never fails a submit that landed, and an enqueue failure on a REVIEW dispatch never bounces the work task (no todo bounce + backoff on the review path — the review lifecycle owns recovery: park/re-arm in-review, #292 r1)) flip the task in-review -> BLOCKED (system action; waiting-answer stays reserved for agent questions; the thread note names the reviewer and the reason, the reviewer's row stays PENDING) — and a park raised while the task ALREADY sits in a child-derived GATING auto-block from an in-review origin (#419) lands the same write with that block's pre_block_status as its park origin (never the blocked id, which would restore into the paused category) and its ladder, so the block's own restore resumes it exactly like any parked round (a ladder-owned park re-fires; a decision-class or final park is never dissolved and still waits for the owner, #419) — a park already standing and an owner move are refused; owner resolution unblocks back to in-review — the status-set unblock-resume re-dispatches the parked reviewer's turn — and the sequence resumes at the parked point. PARK-ORIGIN MEMORY (2026-11-01, #202): the park flip persists tasks.park_from_status (= the in-review status it flipped from) atomically with the blocked write; a parent-gating unblock of a parked task restores that recorded status (never to-do while the round is open) and replays the parked reviewer's turn; a manual status move clears the park memory — owner resolution is the verdict of record. PARK-REARM LAW (2026-11-02, #211): an infra-class park — the review turn's dispatch mint fails, the reviewer's run settles failed/timed out, or the verdict settle throws — is machine-recoverable and re-arms on a bounded backoff ladder instead of freezing: the park write records tasks.park_rearm_attempts + tasks.park_rearm_after (5m/30m/2h/6h, 4 re-fires; the attempt ledger survives the restore so a re-fire cycle is bounded), and the dispatcher tick's parked-round scan re-runs the unblock arm (guarded PARK-ORIGIN RESTORE + reviewer-turn re-dispatch) for BLOCKED rows with a park origin whose ladder is due and whose children are all terminal; a decision-class park (escalation with no eligible target, verdict-less review after its bounded re-dispatch, access-missing) never schedules a re-arm — owner resolution stays the only resume — and resets the ledger; every owner status move clears the ladder (a fresh owner context restarts it at zero), the ladder is inert off BLOCKED (every park write and owner move rewrites it), and the scan is partial-index-backed (park_rearm_after IS NOT NULL) and LIMIT-bounded per tick. When the ladder exhausts, the round parks final (attempts = ladder length + 1, rearm_after null) and the 10-min watchdog alerts the exhausted shape (blocked + park origin + exhausted attempts) — a parked round is never a silent terminal state. STALLED-REVIEW SWEEP (2026-11-10, #397): the dispatcher tick's bounded scan ALSO re-fires a round that COMMITTED but never dispatched its reviewer turn (the crash window between the round-open transaction and the turn): a task the review flow still OWNS — an in_review-category status, or a PAUSED-category GATING auto-block whose recorded origin resolves to an in-review-category id (the #401 mint-gate shape: a child-derived block does not stop the round, and the sweep is the only re-fire a lost mint gets there; a PARK never matches, and neither does an owner move, #419) — carrying a PENDING AI reviewer row in its CURRENT round, with no RUNNING run on the task, no run started for that reviewer since the row was minted, and a row older than 60s, gets ONE sequential review-turn mint per tick TARGETED at that reviewer (never the round's first pending AI row) — the round/run discriminators ride the scan's SQL so a superseded round's leftover row can neither shadow nor starve the live round's row, the task is claimed only by an attempted re-fire, and a reviewer that already had a turn in the round belongs to the verdict-less-correction / park machinery and is never re-fired by this sweep (a run that wrote DONE but lost its settle to a hard crash is the settle-loss shape the SETTLE-REPLAY SWEEP below heals, #402) (the mint's own gate (reviewTurnAllowed) re-checks ownership before the dispatch, so a park or an owner move landing between the scan and the mint mints nothing; review turns take no DB claim, so a move landing inside the mint's own reads can still mint a turn — the end-of-round flip's write-time gate refuses a settle on any status outside the in-review category unless a machine block recorded the round's in-review home, so the owner's move stands (#401)) (a per-row dispatch failure parks on the re-arm ladder; a setup-read failure is retried on the next tick). SETTLE-REPLAY SWEEP (2026-11-11, #402): the tick's bounded scan ALSO heals the settle-loss window — a review turn whose run row reached DONE but whose settle never landed (a hard crash or deploy kill between finish()'s guarded RUNNING→DONE write and its settleDoneRun call) leaves a DONE run + PENDING review row + no later run + no park, a shape NO legal write path produces (a human verdict moves the row off PENDING, a landed settle either resolves the row or mints the next turn, a live turn has its RUNNING row) — by REPLAYING that run's own settle (the run row carries the settle's inputs: its stored output, start stamp and employee) instead of burning a fresh reviewer turn, so the reviewer's real verdict lands; the replay rewrites the run bubble first exactly as finish() would have left it and binds through every existing settle guard (round by run start, row CAS, terminal gate), so a concurrent winner makes it a quiet no-op; the arm is bounded per run (two replay attempts in-process) and fault-isolated — a run still unsettled after its attempts parks the round REARMABLE on the owner with a settle-loss note rather than retrying forever; the scan's discriminators ride SQL (current round, review-flow ownership — in review, or a child-derived GATING auto-block from an in-review origin (#419, the #401 mint-gate shape) — PENDING AI reviewer row, no RUNNING run on the task, the reviewer's NEWEST run in that round is DONE and finished more than 60s ago, and the reviewer is NOT the task's assignee — a work run is always minted for the assignee, so that pairing is ambiguous and never replayed), and a reviewer whose newest run in the round is not that DONE run belongs to the verdict-less-correction / park machinery and is never replayed; the arm runs BEFORE the stalled-round sweep in the same tick, that sweep's scan excludes the lost-settle shape (mirroring this scan's predicates exactly, so a shape the replay refuses is never suppressed), and the LAZY MINT fired by another reviewer's verdict SKIPS a reviewer whose newest run in the round already reached DONE (the settle owns them: a settled turn resolved the row or minted the next, and a lost settle is replayed by this arm) while the ORDERING puts them last for every other caller — a mint therefore never opens a later run that masks a replay on the verdict path, and the recovery callers (owner unblock-resume, removal and heal re-fires) keep the fallback so a parked round can never strand (a re-dispatch there re-derives the verdict instead of replaying it). RESIDUALS (P3): the work-run discriminator reads the task's CURRENT assignee, so a reassignment between a crashed work run and the re-open can still present that work run as a review turn — the replay then rewrites its bubble with the review parser and settles the work transcript under the review vocabulary (a review-shaped JSON line in that transcript would be recorded as a verdict; only a disjoint transcript burns a turn instead); and a lost settle on a reviewer that is also the assignee is matched by neither arm (never replayed by design; the round's other pending reviewers still mint through the stalled sweep's per-row exclusion). MANUAL SETTLE teardown: owner moves the task to done/cancelled -> all PENDING rows supersede, approval obligations cancel, any in-flight review run is refused by the terminal gate — the owner's move is the verdict of record; ABANDON ORDERING (2026-11-10, #397): the abandon's cancel write is BOTH the arbitration and the FIRST write of one transaction — only a WON cancel tears the round down (pending rows supersede, both roles' obligations cancel, the round-closed note commits with it), and a lost abandon writes NOTHING (the winner's round, its rows and its obligations survive untouched; the pre-fix order tore them down and then refused); TERMINAL ARBITRATION (#287): abandon's cancel write arbitrates on the status it read — a concurrent verdict settle (-> done) or submit flip (-> in-review) that won the task between the read and the write keeps its outcome and the abandon refuses (0-row miss, error surfaced), never overwriting a won settle; TERMINAL ARBITRATION binds every lifecycle flip (#292 r1): submitResult's in-review flip and no-reviewer DONE flip and answerQuestion's return flip and forwardQuestion's question-chain move (#369 r3) — and askQuestion's waiting-answer park and the note's dispatch flip (#400) — arbitrate on the status they read — a won abandon/settle keeps its outcome, the losing submit/answer refuses with the error surfaced, a lost ask flip re-reads and re-arbitrates once on the fresh stamp (a benign title/assignee/same-category write must not turn a question into a failed settle — the author's authority is decided on the pre-race read, so a concurrent reassignment never refuses the run's own question) and a second loss refuses with the error surfaced, cancelling or spawning no obligation; the park, its ANSWER obligation AND the question row commit in ONE transaction (every FK-referenced user row — holder and author — key-shared in ONE statement before the task row, matching the employee-delete lock order; the park target is the owner the CURRENT row carries), and a lost note flip retries once on the fresh row — re-running the composer's steer gate first, so a live run (a review turn included) takes the note as a steer, and retrying only a PURE stamp bump: any status change in the window (a dispatch claim, a manual move, a settle flip) owns the row, so the retry falls back to thread-only rather than re-flipping it (a claim commits the status together with its RUNNING row — #406), so a benign write never swallows a dispatch the composer promised (a note or question in flight across a terminal write can never resurrect a settled task), and a lost submit writes NOTHING — the in-review flip, the round's rows and their approval obligations commit in ONE transaction, with the flip as its FIRST write — so no round outlives the settled outcome and no concurrent winner's round is collateral (ROUND OWNERSHIP, #394: the round number is read as max(round)+1 but only a WON flip ever allocates one, so two concurrent submits cannot both mint rows or numbers, the round pointer can never advance past a round that never opened, and a losing submit can never leave a reviewer turn in flight against rows it does not own; the losing submit refuses with the error surfaced while the winner's rows, obligations and round number stay exactly as minted — a reviewer turn is dispatched only after that transaction commits, and a delete/withdraw step on the losing path is gone because there is nothing to withdraw; the flips arbitrate on the read status AND its updatedAt stamp (#292 r2) — any concurrent task write, a re-claim to the same status included, wins and the stale flip refuses (a lost submit NEVER disarms park state — the disarm can only ever strip a concurrent round's legitimate recovery, #292 r3); the gate is WRITE-ENFORCED (#260): the verdict row write is a CAS on status=pending and every end-of-round VERDICT flip is a conditional write REQUIRING the task to still sit in an in-review-category status, or in a PAUSED-category block whose recorded origin (park_from_status / pre_block_status) RESOLVES TO an in-review-category id — a park or a gating auto-block is not an owner move, and the block's own restore arm settles only a live or an extinguished round, so refusing there would strand a decided round; a bare non-null origin is NOT enough — gating records whatever status the task held, and a stale origin would let a hand-made block look machine-recorded, so the owner's manual status move clears BOTH machine origins (park_from_status and pre_block_status), #401 — while a task the OWNER moved out of review refuses the flip whatever it moved to (terminal, waiting_answer, or a plain re-queue/block; categories resolved fresh from task_statuses, custom statuses included) — and each landing states its own outcome: a plain re-queue/block leaves the verdict as a recorded-but-superseded audit row (owner's status kept, no settle-arm note); a terminal landing never reaches the flip (the late-verdict gate refuses it before the row write, so nothing is recorded); a waiting_answer landing belongs to the HOLD clause below (the row reverts to PENDING and the round parks) (the reviewer-removal settle is a separate flip: it pins the status id it read plus updatedAt, #365); SETTLE-CLEARS-GATING LAW (2026-11-12, #423): the review settle's OWN two flips — the end-of-round verdict matrix and the reviewer-deletion settle — exhaust the round's machine memory in the SAME conditional write that lands the status: both gating origins (pre_block_status and park_from_status) clear and the park re-arm ledger resets (park_rearm_attempts 0, park_rearm_after null). An origin is the restore home of a block that EXISTS, so a row that left the block must not carry one (every discriminator resolves those columns on a PAUSED row only, which is exactly why a non-blocked row carrying a home is the shape the #419 arms defend against promoting); the law binds EVERY legal egress from a block that ENDS the round's machine context — the settle's own two flips above, the owner's manual status move (tasks.setStatus), abandon's cancel, the note-dispatch bounce and the idle-liveness bounce (#427): the same statement that lands the status clears both origins and resets the ledger, so no egress can hand a spent ladder or a dead restore home to the task's next block. The idle-liveness bounce is the borderline case and is treated as an egress anyway: its scan window admits a gating auto-block landing between the read and the write, so it CASes on the status it READ (`bounce only if the row is still in the status I scanned`) and carries the same exhaustion — belt and braces, and the CAS is what a lost race is judged on. The block's OWN resume (parent-gating restore, park re-arm) is the deliberate exception: it clears both origins but keeps the attempt ledger (#211's bounded cycles), which is exactly why no reader may treat a non-null ledger as a block signature. The ladder half is load-bearing — parkRound INCREMENTS a surviving ledger, so a closed round's spent ladder would start the task's next infra park mid-ladder or past it (a FINAL park with no auto-recovery). A WON flip then re-runs parent gating FROM THE FLIPPED STATUS, so a task that still owns an open child is blocked again with the settled status as its recorded home (never a pre-flip in-review origin); the walk releases an ancestor only for a TERMINAL landing (that is what lowers the parent's open count) — a re-blocking settle keeps the ancestors gated and a non-terminal landing leaves their count unchanged — best-effort by contract, since the flip already committed: a gating failure there is logged and never surfaced to the caller (the settle outcome stands). REVIEW-TURN MINT GATE (#401, 2026-11-10): a review turn is minted only while the review flow still OWNS the task — in an in-review-category status, or in a GATING auto-block (a PAUSED-category block whose recorded origin is in-review; a child-derived block does not stop the round: its reviewer turn still mints, so a verdict-less correction is never dropped with a PENDING row and no run — nothing else re-fires it) — while a PARK is the round's own stop and mints nothing while it stands — the park restore (an owner unblock or the re-arm ladder) is what re-fires it, and an owner move out of review owns the task outright — every mint caller (the submit's post-commit round-open dispatch, the verdict's lazy mint, a correction re-dispatch, an unblock resume, a park restore, a removal re-fire, the stalled-review sweep) reads the category first and mints nothing for a task a manual move or a park took out of review, since review turns take no dispatch claim; that read only narrows the read→insert window, and the flip's write-time gate is the arbiter for a move landing inside it (settling only when the task is still in review or machine-blocked from an in-review origin). WAITING-ANSWER VERDICT HOLD (2026-11-03, #288): waiting_answer owns the flow — ANY verdict settling while the task is in a waiting_answer-category status never flips the task (non-round-closing verdicts stay decided and the round continues its normal waiting machinery — except the lazy mint of the NEXT reviewer, which the mint gate holds until the answer returns the task to in-review and its unblock re-fires it, #401 — the hold/park mechanics below bind the ROUND-CLOSING verdict): the round parks on the closing verdict (the settling verdict's row returns to PENDING scoped to that reviewer+round, the ANSWER obligation and the waiting-answer status stay untouched, the thread notes the park and the change publishes), and the answer's unblock re-dispatches the held reviewer (row PENDING again) so the round settles normally on a live in-review task (a ready-category landing INSIDE the hold window (the answer's openRoundLive read predates the revert; a coincident manual re-queue reads the same) is repaired: the reverted round's home is restored with ONE guarded ready-category->in-review flip and the held reviewer re-fires); an owner settle landing in that same window heals instead (the just-reverted row supersedes and the APPROVAL obligations cancel — no decision surface outlives a settled task), an in-review landing ALWAYS re-fires from the hold itself (the flip writer's own re-fire can predate the hold's revert — its row read then minted nothing; the hold's re-fire runs after the revert where the held row is PENDING again, the live-turn check bounds duplication and the verdict CAS arbitrates the settle), the spawn precedes the heal's status re-read so either settle ordering self-heals (a settle after the revert finds the row PENDING at its own teardown; a settle before it hits the heal, whose cancel removes anything the spawn inserted), every rescue/heal arm publishes the change event, and any other non-terminal mid-window landing (or a restore flip that loses to a yet-another move) notes the thread — owner unblock to in-review re-fires the held reviewer once the RUN LOCK lifts; the answer's own return flip re-checks round liveness post-flip and repairs a hold-revert it raced (ONE guarded ready->in-review flip + re-fire; a repair flip that loses to a yet-another move notes the thread) — no held round ever strands on a ready or working status without either a re-fire or a thread note; holds on CUSTOM waiting_answer-category statuses (status freedom) re-fire through the owner's manual unblock to in-review — the answer verb reads the waiting_answer category since #265 r2 (custom waiting statuses answer through the verb; owner unblock stays the hold's fallback); the hold re-spawns the held reviewer's APPROVAL obligation (PENDING-dedupe) so human reviewers keep their decision surface; the flip's write-time gate refuses waiting_answer-category statuses alongside done/cancelled (resolved fresh, custom statuses included — a question landing inside the settle window can never be stomped), and a flip refused by that gate re-checks and parks instead of superseding (a decided round must never strand on a waiting_answer task). Review settle-failure PARKS (never the work-run backoff ladder); a verdict-less review NEVER silently approves. The work-run envelope {kind: result|question|blocked, body, subtasks?, reassign?} is unchanged: question/blocked park the task on its owner (waiting-answer), result submits for review / completes; routing rides the same line and is read ONLY from the settled envelope; DELIVERABLES (artifacts-only note) rides every WORK prompt: real files to out/, never the result — no RESULT.md. the run settles on ONE JSON line — the envelope {kind: result|question|blocked, body, subtasks?, reassign?} parsed from the final agent_message (fence-tolerant bottom-up scan; a flush-split verdict is rejoined once) — and it drives the workflow: question/blocked park the task on its owner (status waiting-answer + pending answer obligation — never done), result (or no envelope) submits for review / completes; routing rides the same line and is read ONLY from the settled envelope (in-chain auto-exec law unchanged; echoed task content can never route); RUN SETTLE ARBITRATION (#286): writer.finish's guarded row write (status=RUNNING) is the settle arbiter — 0 updated rows (a reaper or cross-replica stop already settled the run) skips every settle side effect: no message rewrite, no message-attachment embedding (the deliverable collect predates the arbiter and keeps its stored rows gallery-only), no DONE-envelope settle, no review park, no bounce, no change publishes — the winner owns the outcome; session/cancel on timeout then kill; no HERMES_HOME override (the host's own agent home is the employee's environment; isolation = ACP sessions); NO sftp/fuse mounts — bytes stage to ~/.tandem/<taskId>/attachments/ (see attachments flow)
task_attachments(id, task_id -> tasks.id cascade, run_id, kind: input|output, filename, mime, size, sha256, created_by, created_at); bytes on disk per task under TANDEM_ATTACHMENTS_DIR (default root /tandem → /tandem/tasks/<taskId>/attachments/<id> — all Tandem data lives under /tandem/**); BYTES-WITH-TASK LAW (2026-11-01, #150): removing a task removes its stored attachment bytes with the rows — the whole per-task attachments dir is swept after the row delete
attachments flow: inputs upload via REST multipart (20MB cap, MIME allowlist png/jpeg/webp/gif/pdf/txt/md/csv/json/zip), token `![name](attachment-<id>)` / `@[name](attachment-<id>)` embedded in description; dispatch pushes inputs over SFTP to the agent host at ~/.tandem/<taskId>/attachments/ (relative paths resolve to the environment SSH user's home on every OS; chowned to the agent uid on hermes images) and lists them in the brief; PROMPT-INLINE IMAGES (2026-10-31): at dispatch, input image attachments that pass the prompt filter (mime png/jpeg/webp/gif, 0 < size <= 5 MiB, first 6 by filename asc within a 12 MiB total budget) are read from the attachment store and inlined into the ACP session/prompt as image content blocks (base64 data + mimeType, filename-asc order) appended after the brief text block; SFTP staging stays universal — inlining is additive and the staged copy remains the agent's fallback; filter misses (mime, empty file, size, count, budget) and unreadable bytes stay staged-only, the brief labels inlined images 'image — inlined into this prompt' and staged-only ones 'image — view with your image tool', and an unreadable inline candidate logs a dispatch line instead of failing the run; mid-turn steers remain text-only; review turns inline the same input set (reviewers judge the evidence first-hand); agent deliverables left in ~/.tandem/<taskId>/attachments/out/ are collected back post-run (50MB cap) as kind='output' rows under their run; collected outputs are idempotent per task (2026-11-01, #160): a byte-identical output (same sha256, kind='output') already stored for the task is never stored again under a later run — re-collection of surviving staging can neither duplicate rows nor re-embed old images into new result messages; RESULT-MESSAGE ATTACHMENTS (2026-10-31): image outputs ride the run's result message itself — images collected from out/ that pass the message filter (mime png/jpeg/webp/gif, 0 < size <= 5 MiB, <= 6 per message, ordered by filename asc) are appended to the run message body as `![name](attachment-<id>)` tokens right after the parsed result text; the run bubble parses body tokens (images inline, files as chips — same grammar as the brief) and the deliverable gallery under the bubble shows only outputs NOT already carried by the body; non-images, filter misses, review runs (collect runs detached) and collects slower than the bounded 20s verdict window stay gallery-only rows; the sandbox task dir ~/.tandem/<taskId>/ is removed once no OTHER run of the task is running (2026-11-01, #160: the settling run's own still-RUNNING row is excluded — its status flips only at finish — and the sweep runs on every settle, success included; it never was failure-path-only); serve route GET /api/attachments/:id honors etag (sha256) revalidation; TASK-REMOVAL BYTES LAW (2026-11-01, #150): removing a task removes its stored attachment bytes with the rows — after the row delete the whole per-task attachments dir (inputs, collected outputs, any leftover file) is swept best-effort (a failed sweep logs and never fails the remove — byte cleanup can never block task removal); bytes live exactly as long as the task does
redis (REDIS_URL; REQUIRED — the boot env schema rejects boot when unset, every mode; no in-process fallback path exists): bullmq queue 'tandem-dispatch' (retries/backoff) + pub/sub change-bus fanout (the app's only in-memory model cache is a plain Map, no redis cache layer exists)

REDIS RECONNECT-SELF-HEAL LAW (#238): redis unavailability of ANY duration self-heals without a process restart — the long-lived queue connection (worker + enqueue paths) reconnects FOREVER with capped backoff (never a retry count that terminally abandons the client), so workers resume and offline-queued enqueues flush when redis returns; only the BOOT connectivity ping keeps a fail-fast no-retry strategy (a dead redis at boot must reject loudly and let the boot retry loop re-fire, #147). Brick-detection contract: the dispatcher tick best-effort stamps settings key `dispatcher_redis_ok` (epoch ms, written ONLY when a redis ping succeeds, same 30s throttle + best-effort catch as the dispatcher heartbeat) so the prod watchdog can distinguish "app alive but dispatch path dead" (heartbeat fresh + redis stamp stale >120s → probe alerts `dispatch_redis_unreachable`) from "dispatcher dead" (heartbeat stale). An absent key is a pre-image shape and stays silent, same rule as the heartbeat.
mcp_servers(id, name unique, transport http|stdio default http, url http/https, command abs path, args json array, credential_env_var, notes, auth_kind none|oauth, oauth_authorize_url, oauth_token_url, oauth_revocation_url, oauth_scopes, oauth_client_id, oauth_client_secret_id -> vault_secrets.id set null, created_at, updated_at) + mcp_server_bindings(id, employee_id -> user.id cascade, server_id -> mcp_servers.id cascade, secret_id -> vault_secrets.id set null, last_probe_ok, last_probe_detail, last_probe_at, unique(employee_id, server_id)) + mcp_oauth_tokens(id, binding_id -> mcp_server_bindings.id cascade UNIQUE, access_enc, refresh_enc, expires_at, scope, config_fingerprint, created_at, updated_at) + mcp_oauth_states(id=state pk, binding_id -> mcp_server_bindings.id cascade, code_verifier, redirect_uri, config_fingerprint, expires_at, created_at) — MCP registry + per-agent bindings: the BINDING is the permission unit (registry admin-written); the binding's optional vault credential rides dispatch as the server's Authorization header; auth_kind=oauth servers authorize per binding via the Tandem-hosted PKCE flow (see "MCP (registry + per-agent bindings) — OAuth per binding") and their binding-level PROBE VERDICT LAW persists last_probe_*
bun serve: NITRO_BUN_IDLE_TIMEOUT defaults to 255 (code, boot plugin — Bun's max; default 10s would kill idle SSE feeds); env can override
resilience: tasks.dispatch_after + fail_streak (backoff ladder 1m/5m/15m, quota -> 15m); reaper fails stale running rows past the run-timeout setting + grace; sweep failures log rate-limited and boot's dispatcher start retries on a fixed interval until the queue is reachable (#147); boot's change-fanout pub/sub bridge retries a bounded 5 attempts / 2s and then logs loudly and CONTINUES serving with degraded cross-replica fanout (2026-11-03, #289) — a redis blip at restart never aborts boot, never crash-loops the process, never leaves a replica silently unseeded; ssh keepalive 15s
```

Runner (M5) dispatches every run as **ACP v1** (Agent Client Protocol) — the
authoritative law is the Domain model's `dispatch = ACP v1` paragraph; the
transport contract in one place:

- the runner spawns the employee's ACP executable (required, shell-word-validated,
  e.g. `hermes acp`) over SSH stdio — the env blob's byte-count is framed on stdin
  ahead of the JSON-RPC stream
- `initialize` advertises NO client capabilities (no fs/terminal — agents never
  touch Tandem); permission requests are auto-allowed (headless parity) and logged
- the ACP session lives on the run row (`task_runs.session_id`): the first turn
  opens session/new, later turns by the SAME employee resume their latest run's
  session on the task (answer, review, re-dispatch); the agent process is killed
  after every turn; sessions are per task×employee
- `session/update` streams live into the run log (the run's `output` — the
  RUN-TRANSCRIPT LAW's live surface); the run settles on the final `agent_message`
  JSON line (the envelope) which drives the workflow
- run timeout: Settings `run_timeout_ms` — the turn is cancelled (session/cancel)
  at the cap, then the process is killed; the reaper uses the same value
- human stop (#229): the STOP-RUN VERB aborts the live turn through the same
  transport — session/cancel over the runner's stream, then the cancel-grace kill —
  and settles the run STOPPED (the CAS settles; the turn's own settle path skips
  every side effect for a stop-settled row). The stop hook shares the steer hook's
  TRANSIENT lifecycle (registered at onSessionOpen, deleted when execution exits)
- MCP injection (#270 slice 1, SPEC "MCP (registry + per-agent bindings)"): the
  runner serializes the dispatching employee's bindings onto EVERY
  `session/new` + `session/resume` `mcpServers` param — http servers
  `{ type: 'http', name, url, headers: [{ name: 'Authorization', value:
  <plaintext verbatim> }] }`, decrypted server-side at dispatch only; no
  bindings = the spec-shape empty list; unbinding revokes on the next dispatch
- concurrency: PER-AGENT BullMQ queues (`tandem-dispatch-<agentId>`), each
  worker's concurrency = `tasksPerAgent` — there is NO per-environment serial queue

## MCP (registry + per-agent bindings)

Slice 1 — transport `http`, static credential only. Slice 2 adds OAuth per
binding (section below). Slice 3 adds the `stdio` transport (section below).

- **Registry** = admin-managed catalog of MCP servers (`mcp_servers`): name
  (unique, 409 on clash incl. rename), url (http/https), notes. Reads are
  session-tier.
- **Binding = the permission unit**: `mcp_server_bindings` links one AI
  employee to one registry entry (unique pair) with an OPTIONAL vault
  credential. The secret's plaintext IS the credential — sent verbatim as the
  `Authorization` header value to that MCP server. Write-only vault law: no
  API ever returns it; the binding carries the vault ref + last-four hint
  only. Bindings are written by admin verbs only.
- **Binding surfaces (UI parity, #274)**: bindings are manageable from BOTH
  admin surfaces — the AI employee editor (per agent, `mcp.bindingsList`) and
  the registry page (per server, `mcp.bindingsListByServer`: bind/unbind
  agents + set the binding credential directly on the entry's row). Same
  write verbs, one data model; every write publishes the change bus so both
  views stay in sync without a manual refresh.
- **Dispatch injection (ACP contract)**: every ACP dispatch of an employee
  carries ALL of that employee's bindings in `session/new` and
  `session/resume` `mcpServers` as `{ type: 'http', name, url, headers:
  [{ name: 'Authorization', value: <plaintext verbatim> }] }` (ACP v1 wire:
  `headers` is a REQUIRED array — empty when the binding has no credential) —
  decrypted
  server-side at dispatch only, never logged, never written to run output
  (the run output NAMES bound servers, never credentials). `stdio` entries
  serialize as the ACP v1 stdio member (below). No bindings = the
  spec-shape empty list. Unbinding revokes on the NEXT dispatch; a live
  session keeps its servers until it ends.
- **Probe (binding-level)** — mirrors the environments PROBE VERDICT LAW:
  POSTs the registry url with a JSON-RPC `initialize` handshake (Accept
  `application/json, text/event-stream`, 10s cap), Authorization from the
  bound secret when present; BOTH outcomes persist on the binding row
  (`last_probe_ok/detail/at`; null = never probed). A registry url change
  clears every verdict of that server's bindings; a binding credential change
  clears its own verdict. Failure detail carries the first error line — never
  a bare "unreachable".
- **In-use guards**: registry remove with live bindings → 400 (unbind first);
  secret remove joins the vault in-use guard for MCP bindings.
- **Fake-runner parity** (test transport): the fake runner prints
  `[mcp] servers: <names asc, comma-space>` into the run output exactly when
  the dispatch plan carries bindings — the same plan the real runner
  serializes onto the wire.

### stdio transport (#270 slice 3)

- **Registry shape**: a registry entry carries `transport` `http | stdio`
  (default `http` = exactly the slice-1/2 contract). `http` entries keep url
  (http/https). `stdio` entries carry `command` (ABSOLUTE path to the
  executable — the ACP v1 wire contract) and `args` (a JSON array of
  strings, `[]` allowed; entries are non-empty single-line strings without
  padding whitespace — the registry form edits them one per line), plus an
  optional `credentialEnvVar` (env var name
  matching `[A-Za-z_][A-Za-z0-9_]*`). Validation: create/update REJECTS a `stdio`
  entry without `command`, a `http` entry without `url`, and ANY oauth
  config on a `stdio` entry — OAuth authorization is an http contract
  (endpoints + Bearer headers have no stdio meaning), so a transport switch
  to `stdio` on an `authKind=oauth` entry is refused 400, never silently
  stripped (the refusal keys off the entry's PERSISTED authKind, not the
  caller's echo). A transport switch nulls the other transport's columns —
  a `stdio` entry carries no url; an `http` entry carries no
  command/args/credentialEnvVar.
- **Verdict invalidation (PROBE VERDICT LAW parity)**: a transport switch or
  a `command`/`args`/`credentialEnvVar` change clears every verdict of that
  server's bindings — same law as a url change (a stale OK on a changed
  target would lie). A no-op save keeps verdicts intact.
- **Binding credential on stdio**: the bound secret's plaintext rides
  dispatch AND probe as the env var NAMED by `credentialEnvVar` (when set
  and the binding has a credential; `env` carries only that var — the child
  inherits nothing else). No `credentialEnvVar` or no credential → empty
  `env`. The write-only vault law is unchanged: plaintext decrypted
  server-side at dispatch/probe only, never returned by any API surface,
  never logged, never in run output — and a probe verdict is REDACTED
  before persistence (the probed child SAW the credential, so any
  occurrence of the plaintext in its stderr, JSON-RPC error or serverInfo
  strings is masked `[redacted]` before `last_probe_detail` lands).
- **Dispatch injection**: `stdio` entries serialize as the ACP v1 stdio
  member `{ name, command, args, env }` — one deterministic
  plan with the `http` entries, sorted by server name. `args` is the parsed
  JSON array. (The stdio member carries NO discriminator — the `type` field
  exists only on the http/sse members.)
- **Probe (stdio)**: spawns `command args` (+ the credential env var),
  writes a JSON-RPC `initialize` handshake to the child's stdin and expects
  a JSON-RPC response on stdout within the 10s cap, then kills the child —
  a probe never leaves a spawned process running. BOTH outcomes persist on
  the binding row (PROBE VERDICT LAW); failure detail carries the first
  error line — never a bare "spawn failed".
- **Surfaces**: the registry page renders the transport switch + the
  command/args/credentialEnvVar fields for `stdio` (url for `http`); the
  agent-editor MCP section and the per-server binding manager show the
  entry's transport.
- **Per-binding tool allowlists — deferred, agent-side gap**: the ACP v1
  wire has no per-server tool-filter field and the agent adapter's
  `register_mcp_servers` accepts configs straight through (no allowlist
  hook), so a binding-level allowlist would be dead UI today. The lane
  tracks it for a later slice once the agent side grows per-server tool
  filtering; building the Tandem half first would ship a control with no
  effect.

### OAuth per binding (#270 slice 2)

- **Registry OAuth config**: a registry entry carries `authKind`
  `none | oauth` (default `none` = exactly the slice-1 contract). `oauth`
  requires authorizeUrl + tokenUrl + clientId (http/https); optional:
  revocationUrl (RFC 7009), scopes (space-separated), clientSecret as a
  registry-level vault secret ref (confidential client; PKCE always rides
  the flow). An OAuth-config write that CHANGES the effective config (the
  kind switch or any endpoint/client/secret/scope value) wipes the stored
  tokens AND pending connect state of every binding to that server and
  clears their verdicts — tokens minted under an old client contract never
  survive it, and a pre-edit callback can never complete against it (the
  state row carries a fingerprint of the config it was minted under). A
  no-op save (same values echoed back) keeps tokens and verdicts intact,
  and the wipe commits atomically with the config write.
- **Tokens are per binding**: `mcp_oauth_tokens` (unique per binding) holds
  the access + refresh tokens AES-GCM encrypted at rest under the SAME vault
  envelope law — decrypted server-side at dispatch/probe only, never
  returned by any API, never logged, never written to run output. Every
  token row carries the config fingerprint it was minted under; a row whose
  fingerprint no longer matches the server config is INERT — deleted on
  read, never shipped (read-time enforcement makes old-contract tokens
  harmless regardless of any write race). Refresh persistence is
  UPDATE-only — a refresh can never re-create a wiped row. Masked status
  only rides reads (`connected` + expiry). The session-tier registry read
  carries the client-secret ref + presence flag, never the secret's name;
  the OAuth client secret joins the vault in-use guard, and ROTATING that
  secret is a contract change: it wipes the referencing servers' tokens +
  pending state and clears their binding verdicts.
- **Authorize flow**: the mint is an admin-only oRPC POST,
  `mcp.oauthConnect` (`employeeId` + `serverId`): it requires an existing
  binding and an `oauth` registry entry, persists a single-use state row
  (PKCE S256 verifier, redirect_uri, 10-minute TTL) and returns the
  provider's authorizeUrl for the admin browser to open. There is NO
  same-site GET mint endpoint: a state-changing GET would ride the
  SameSite=Lax admin session on a forged top-level navigation (the
  CSRF-intent binding class, #278 — a crafted link could make an admin
  initiate authorization for a binding they did not choose). The POST
  cannot be CSRFed (Lax drops cookies on cross-site POSTs), so a forged
  link finds nothing to hit and the provider loop never starts. The
  provider returns to `GET /api/mcp/oauth/callback` (`code` + `state`):
  the state is consumed on FIRST use (replay/expiry = 400), the code is
  exchanged server-side (client secret + code_verifier when configured),
  and the resulting tokens are stored on the binding. The callback renders
  a close-this-window result page and notifies the opener — the
  single-use state row is the authorization proof.
- **Dispatch injection (OAuth)**: an `oauth` binding injects the
  `Authorization` header with scheme `Bearer` and the binding's decrypted
  access token as the value; when the token is missing, expired
  or expiring within 60s the dispatch refreshes it first (grant_type
  `refresh_token`, single-flight per binding, refreshed tokens persisted).
  A failed refresh NEVER breaks the dispatch — the stale access token ships
  (none = empty headers), the next dispatch re-arms. Static-credential
  bindings keep the verbatim slice-1 header.
- **Probe**: an `oauth` binding probes through the same refresh path, then
  the JSON-RPC initialize with the Bearer token; the verdict persists per
  the law above.
- **Unbind = revoke**: removing a binding POSTs the configured revocationUrl
  best-effort (5s cap; a failed revoke never blocks the unbind) for BOTH the
  access and the refresh token (the refresh token is the durable grant) and
  deletes the token row — the same revocation rides employee removal, whose
  cascade deletes bindings. OAuth authorization is binding-scoped, never
  task- or session-scoped.

### MCP procedures

| procedure                  | auth    | input                                                                                 | result                                                                                                                                                                                                      |
| -------------------------- | ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.registryList`         | session | —                                                                                     | `{data:[{id,name,transport,url,command,args,credentialEnvVar,notes,authKind,oauth:{authorizeUrl,tokenUrl,revocationUrl,scopes,clientId,clientSecretId,hasClientSecret},createdAt,updatedAt,bindingCount}]}` |
| `mcp.registryCreate`       | admin   | `{name,transport?,url?,command?,args?,credentialEnvVar?,notes,authKind?,oauth*}`      | created row (transport-conditional validation: stdio needs command; http needs url; oauth ∩ stdio refused)                                                                                                  |
| `mcp.registryUpdate`       | admin   | `{id,name?,transport?,url?,command?,args?,credentialEnvVar?,notes?,authKind?,oauth*}` | updated row (url OR transport/command/args/credentialEnvVar change clears that server's binding verdicts; a CHANGED OAuth config additionally wipes its oauth tokens + pending connect state)               |
| `mcp.registryRemove`       | admin   | `{id}`                                                                                | `{ok}` (400 while bindings exist)                                                                                                                                                                           |
| `mcp.bindingsList`         | admin   | `{employeeId}`                                                                        | `{data:[{id,serverId,serverName,transport,url,authKind,secretId,secretName,lastFour,oauth:{connected,expiresAt},lastProbeOk,lastProbeDetail,lastProbeAt}]}`                                                 |
| `mcp.bindingsListByServer` | admin   | `{serverId}`                                                                          | `{data:[{id,serverId,serverName,employeeId,employeeName,transport,url,secretId,secretName,lastFour,authKind,oauth:{connected,expiresAt},lastProbeOk,lastProbeDetail,lastProbeAt}]}`                         |
| `mcp.bindingsSet`          | admin   | `{employeeId,serverId,secretId?}`                                                     | binding row (upsert; verdict cleared on credential change)                                                                                                                                                  |
| `mcp.bindingsRemove`       | admin   | `{employeeId,serverId}`                                                               | `{ok}`                                                                                                                                                                                                      |
| `mcp.probe`                | admin   | `{employeeId,serverId}`                                                               | `{ok,detail,durationMs,lastProbeAt}`                                                                                                                                                                        |
| `mcp.oauthConnect`         | admin   | `{employeeId,serverId}`                                                               | `{connectUrl,serverName}` (mint: single-use state row + provider authorizeUrl; no GET mint route — see the authorize-flow bullet below)                                                                     |

OAuth connect rides the admin oRPC POST `mcp.oauthConnect` (NOT a REST
route — #278: a state-changing GET rode SameSite=Lax admin sessions on
forged top-level navigations; the POST mint returns the provider
authorizeUrl for the browser to open). The provider returns via the REST
browser redirect `GET /api/mcp/oauth/callback?code&state` (consumes the
single-use state, exchanges + stores the binding's tokens, renders the
close-this-window result page).

## Channels (backend relay, contract v1 — #271 slice 1)

Channels are transport owned by the backend: a channel message routes into the
task thread through the SAME procs as the web composer (composer law — no
parallel decision tree), the existing ACP pipeline runs the agent, and replies
relay back. Agents never touch channel credentials (hermetic law). The adapter
contract is versioned: adding a channel = one new adapter file, zero core
changes.

### Adapter contract (v1)

```
ChannelAdapter {
  kind; capabilities {edit, threads, maxLen, markdown};   // edit=false → final-only outbound
  start(ctx: {onMessage(m), checkpoint {get, set}}); stop(); isLive?()
  send(target, text)                                       // transport-level, no routing
}
ChannelInboundMessage { threadRef, senderPlatformId, text, raw, externalId }
```

- One adapter per channel kind (`matrix` first, self-hosted; discord/slack
  follow). The core never branches on kind; a new kind = one adapter file plus
  one explicit registry-arming line in the core (the explicit call is required
  — a bare side-effect import is tree-shaken out of the Nitro bundle). Per-kind
  config fields are slice-2 work; slice 1's config shape is matrix-shaped.
- `capabilities.edit=false` adapters are final-only outbound (no edit-in-place).
- Channel credentials live in the vault; config references the secret id. The
  service resolves plaintext only in-process; plaintext never persists.

### Identity binding (default deny)

- A platform user id acts AS a Tandem user ONLY via an explicit admin-managed
  binding (`{platformUserId, userId}`); unbound senders are refused with a
  polite notice and their message is recorded (processed, refused) — never
  routed, never dispatched.
- The bound user must exist AND hold EMPLOYEE or ADMIN (SPEC: Roles & access —
  every channel verb is a `tasks.*` write): a VIEWER/deleted binding is refused
  exactly like the oRPC kernel refuses it. Binding user ids must be uuids.

### Inbound durability (deploys drop nothing)

- Every inbound message persists raw FIRST (`channel_events`, unique per
  `(adapter, externalId)` — replay-safe across same-kind configs), then the
  sync checkpoint advances,
  then a BullMQ job processes the row; workers re-run idempotently
  (`processed_at` guard + the event id AS the `jobId` so a job already
  queued/active is never duplicated; failed jobs drop their id immediately so
  the sweep can re-drive them; a `claimed_at` CAS makes exactly ONE worker own
  an event at a time — deferral cycles, sweep and deploy overlap carry
  different job ids and could otherwise double-route — and a stale claim
  becomes re-claimable after 5 min, keeping at-least-once). Boot sweeps
  unprocessed rows (partial-indexed) back into the queue AFTER adapters and
  the worker are live.
- **Deferral law (no silent loss)**: an event whose adapter has no enabled
  config or no LIVE adapter (isLive false — e.g. token rejected) is NOT
  consumed; it re-enqueues itself every 5 min (bounded: 12 deferrals ≈ 1h,
  then it stays raw for the next boot sweep). A config typo or dead token must
  never destroy user messages.
- Matrix checkpoint: the sync `next_batch` token, stored per channel in
  settings (`channels:checkpoint:<kind>:<homeserver>`). First-ever boot skips
  history (new events only); every later boot resumes from the checkpoint.

### Routing verbs (slice 1: note / answer / new-task only)

- Unmapped thread + bound sender → **new-task**: task created exactly as the web
  composer creates one (first NON-EMPTY trimmed line ≤200 chars = title, full
  body = description capped at the composer's 10k, owner/creator = bound user;
  a message with no non-empty line is refused, never an empty-title task;
  optional channel default assignee attaches after existence check — an AI
  assignee on a ready status auto-dispatches through the existing dispatcher).
- Mapped thread → **note** through `addNote` (steer-live / dispatch-stopped
  composer law verbatim), or **answer** when the status category is
  `waiting_answer` (the reserved answer verb; a note must never stomp an open
  question). Verb pick keys off status CATEGORY, never seeded ids (#265 law).
  Thread mappings are keyed by the ORIGINATING adapter (`adapter, thread_ref`)
  — the same room id on two homeservers stays two independent threads.
- A blank (whitespace-only) message is refused on EVERY verb — it never
  creates an empty-title task and never lands an empty note/answer.
- Mapped thread whose task is terminal (done/cancelled category) → no note; the
  sender gets "closed — start a new task in this channel" (thread stays mapped
  for reference).
- Ack culture: every accepted message gets an instant outbound ack (created /
  steered / dispatched / noted / answered / closed / refused). Acks are adapter
  `send` with the capabilities maxLen cap.

### Channel config

- Settings key `channels` holds the JSON array of `{kind, enabled,
  homeserverUrl, tokenSecretId, bindings[], defaultAssigneeId?}` (admin-managed;
  the settings-UI slice's admin verbs read and write this key). Tolerant
  parse: invalid entries are skipped and logged; a corrupt value reads as no
  channels (fail closed). `homeserverUrl` is canonicalized (case, default
  port, trailing slash) before dedupe — one bot per homeserver, duplicates
  refused. Binding user ids must be uuids (a non-uuid id could never route).
  Boot starts adapters for enabled configs unless `TANDEM_NO_DISPATCHER=1`
  (shared test opt-out); PARTIAL-START LAW: a start that leaves any adapter
  not live keeps retrying on a 30s loop (a resolved call with failures is not
  success), and dead adapters (fatal token stop) are stopped + re-armed by the
  same loop. The stored `channels` value is under
  the settings integrity audit (corrupt → readiness 503).
- Matrix slice-1 capabilities: `{edit:false, threads:false, maxLen:4000,
  markdown:false}` — unencrypted rooms only (no crypto), plain-text send,
  invites are NOT auto-accepted (admin invites the bot per room). The adapter
  resolves the bot's own user id via `account/whoami` on EVERY start
  (fatal-if-failed) — the sync response carries no user id, and without the
  self id the bot's own acks would re-enter the sink as inbound notes and loop
  (echo guard). Events persist under their ORIGINATING adapter key
  (`kind:homeserver`) — bindings, acks and routing never cross same-kind
  configs; message bodies ride the composer's caps (title ≤200 chars,
  title/body/answers ≤10k). Durability is AT-LEAST-ONCE: the processedAt guard
  prevents retry storms, and a crash mid-verb can re-apply that verb's effect
  once — no-loss wins. Replies relay as plain acks; streaming bubble, edit and
  gappy sync backfill are later slices of #271.

### Channel settings UI (slice 4: admin config surface)

- Admin oRPC verbs on a `channels` router. `channels.list` returns, per STORED
  entry (enabled and disabled alike — a disabled channel is a configured one,
  not an invisible one): the entry fields, a `status` of `ok` or `dropped`, the
  canonical adapter key (`kind:homeserverUrl`) when parseable, the drop reason
  when not, plus the registered `kinds`, the latest `channels:health` stamp
  (shape-guarded including its elements: a valid-JSON but wrong-shape stamp —
  non-array channels or garbage entries — reads as absent; it must never crash
  the reading UI), and the settings row's `updatedAt` as the
  concurrency base for the card's writes — a dropped config is visible in the
  UI, not only in watchdog stamps.
  Admin-only (channel config is admin-managed, "Channel config").
- `channels.update` REPLACES the whole stored array. The admin write path
  validates STRICTLY — an invalid entry is REFUSED with its reason and NOTHING
  is written. The runtime parser's tolerant skip is the safety net for
  hand-edited values, never the UI path's behavior: the UI must never write a
  config the runtime will silently drop. Validation enforces the SAME rules the
  runtime parser enforces (schema shape, registered kind, uuid binding/assignee
  ids, canonicalized homeserver URL) through the SAME per-entry inspection code
  path, so the admin path and the runtime parser cannot drift — plus the
  ADMIN-PATH-HYGIENE rule: duplicates of the same canonical adapter key are
  refused regardless of the enabled flag (an enabled+disabled pair for one bot
  is ambiguous config the UI cannot safely operate on — one bot per
  homeserver), and unknown keys are refused at every nesting level (strict
  admin input; the runtime's tolerant strip stays untouched). Exact-content
  duplicates (byte-identical after canonicalization) collapse to ONE channel
  everywhere: the runtime keeps the first and drops the rest, and the admin
  path refuses them. Every write carries the `updatedAt` base the admin
  rendered from (optimistic concurrency): the gate is the WRITE ITSELF — a
  conditional commit keyed on the stored row's `updatedAt` (atomic; a drifted
  or interleaved base refuses, never merges, and the list snapshot reads
  value + base in one row read so the rendered base can never be newer than
  the entries it accompanies) — a stale snapshot can never silently delete or
  revert rows another admin added between its load and its write (the admin
  reloads and retries). Beyond parser
  parity the write checks existence: the token secret must exist in the vault,
  binding user ids and the default assignee must be existing users.
- A successful update re-arms the channel runtime IN-PROCESS against the
  committed value: added/enabled adapters start, removed/disabled ones stop, a
  config edit under an UNCHANGED adapter key restarts that adapter too (the
  running adapter captured the old config at start — the runtime runs what is
  stored, not what was started), and a start that leaves failures re-arms the
  existing 30s partial-start retry loop (PARTIAL-START law unchanged). The
  re-arm never blocks the admin write response (it rides the background; the
  committed value is durable and the retry loop converges). No process restart
  is ever required for a config change. The update publishes the SETTINGS
  change resource (settings subscribers refresh).
- UI: a Channels card on the Settings page (admin-only surface). One list of
  stored entries — kind, homeserver, enabled, binding count, health chip
  (connected / last sync age / dropped-with-reason) — with add, edit, delete
  and an enabled toggle; the editor collects kind (registered kinds only),
  homeserver URL, token secret (vault picker), optional default assignee and
  platform→user bindings. Frontend validation is presence-only (repo law): the
  server is the source of truth and its refusal reason is what the UI shows.

### Watchdog health (slice 3: per-channel liveness stamps)

- The channels service stamps settings `channels:health` on a 60s tick
  (best-effort: its own catch — observability never crashes the tick, same law
  as the dispatcher heartbeat), plus once at the end of every successful boot
  start: JSON `{"stampedAt": <epoch ms>, "channels": [{"key", "kind",
  "homeserverUrl", "connected", "healthCap", "healthOk", "lastSyncOkAt"}]}`, one entry per ENABLED
  config whether or not its adapter started — a config whose adapter failed to
  start reports `connected:false`, and that IS the signal; an enabled entry the
  config parser DROPPED (unknown/unregistered kind, invalid shape) is stamped
  too (`connected:false`, `healthCap:false`) — a dropped config must never be
  invisible to the watchdog. `connected` mirrors
  the adapter's live state in THIS process; `lastSyncOkAt` is the adapter's
  last successful TRANSPORT round-trip (matrix: a sync poll that returned
  ok + next_batch, stamped independently of sink delivery — a sink outage
  surfaces as backlog, never as a stale transport stamp). Zero enabled configs
  stamp an empty `channels` array (a disabled channels setup must not read as
  a stale fault). Absence of the key (pre-slice image, or the boot never
  completed a start) stays silent — same semantics as `dispatcher_last_tick`.
- The stamp separates two failure classes with distinct watchdog alerts:
  process liveness (`stampedAt` stale, or any `connected:false` — the tick
  itself is dead, or an adapter is down/dead-token) and transport health
  (`connected:true` with `lastSyncOkAt` stale — the sync loop is alive but the
  homeserver is unreachable and backing off). Each entry also carries
  `healthCap` (whether the adapter implements `health()`) and `healthOk`
  (whether a health read HAPPENED and succeeded — a missing adapter or a
  missing health() is no read, so `healthOk:false` there too): a NON-capable
  adapter's `lastSyncOkAt: null` is not alertable; a CAPABLE adapter whose
  read SUCCEEDED (`healthOk:true`) with `lastSyncOkAt: null` means "no
  successful transport round-trip in this process yet" — alertable after a
  grace window; a FAILED health read (`healthOk:false`) downgrades its null
  to a telemetry fault — never alertable, a broken health() must not
  fabricate the never-synced shape. The never-synced shape arises when a
  start SUCCEEDED (whoami ok) but the transport has never completed a
  round-trip (e.g. the homeserver starts failing after start); a RESTART
  into a dead homeserver instead shows `connected:false` — whoami fails, the
  adapter never registers, and the outage is visible via the liveness class.
  Queue depth is deliberately
  NOT stamped: it is DB-derivable, so the watchdog derives backlog
  (unprocessed `channel_events` + `channel_outbox` rows, count + oldest age)
  from the tables directly. Backlog with a healthy stamp = a pipeline wedge
  the stamps cannot see; backlog with a stale stamp = the expected
  adapter-down shape (deferral parity holds the rows — no-loss, nothing is
  consumed).
- The adapter contract gains an OPTIONAL `health()` — an adapter without it
  reports `healthCap:false` + `lastSyncOkAt: null` (the watchdog does not
  invent a fault from a missing capability). The liveness and health reads
  are isolated PER READ: a throwing `isLive()` degrades to
  `connected:false`, a throwing `health()` to `healthOk:false` — neither
  kills the whole stamp nor fakes the other's fault shape.

### Reply relay (slice 2: final-only outbound)

- A run that settles DONE on a task mapped to a channel thread (any
  `channel_threads` row for the task) relays its reply to that thread — one
  `channel_outbox` row PER mapped thread, ALL rows persisted BEFORE any queue
  job (deploys drop nothing, same law as inbound: a mid-relay failure leaves
  every mapping's row raw for the boot sweep, never a half-set). The unique
  `(adapter, run_id, thread_ref)` index dedupes ROWS; enqueue idempotence
  comes from kicking only newly-inserted rows plus the queue's jobId dedupe —
  a re-settled run can never enqueue a reply twice. A RESTART can run two
  parallel cycle chains for one row (a surviving delayed job plus the sweep's
  fresh kick): safe by the claim CAS — one send wins, the loser no-ops.
  Durability stays AT-LEAST-ONCE end-to-end (slice-1 law): a crash
  between a successful send and the processed-at write — or any
  failed/ambiguous send retried per the deferral law — can deliver that one
  reply twice; no-loss wins, the same bound the inbound verbs carry.
- The relayed text is the thread turn's visible body — the run message body
  after the settle rewrite (envelope text, else the human tail; agent prose,
  never tool logs), with result-attachment tokens stripped (platform-external
  syntax) and the inbound sanitizer applied. The text is capped to the
  adapter's `capabilities.maxLen` at send time.
- FINAL-ONLY (contract v1: `capabilities.edit=false`): the relay sends the
  finished reply once — no streaming bubble, no edit-in-place on channels that
  cannot edit. Streaming/edit is a later slice.
- Trigger is BEST-EFFORT: the run-settle path never fails because relaying
  failed — a relay error is logged, never thrown into settle. The trigger
  fires once, after the settle commits; it runs LAST among the settle side
  effects, so a failure of any preceding one (message rewrite, attachments,
  settle, publishes) skips the relay exactly like a process death in that
  window — no re-driver exists pre-insert; the at-least-once guarantee starts
  at the outbox row, exactly like every other settle side effect.
- Per-thread ordering: the outbound worker sends at most one row per
  `(adapter, thread_ref)` conversation at a time and always the OLDEST
  unprocessed one — replies land in settle order even when the queue runs
  concurrent workers.
- Deferral law (parity with inbound): a row whose adapter has no enabled
  config or no LIVE adapter is NOT consumed — claim released, re-driven every
  5 min, bounded (12 deferrals ≈ 1h) then it stays raw for the next boot
  sweep. The budget rides each re-drive chain: a restart starts a fresh
  cycle, so a flapping deploy can extend the raw window — the row is still
  never consumed. A failed SEND releases the claim for job retry with
  backoff; the row survives terminal job failure (at-least-once) — a
  non-retryable send failure consumes its job deliberately, leaving the row
  raw for the next boot sweep, so between that failure and the next restart
  the row IS jobless (stated, not accidental). A worker killed MID-send
  leaves a claimed row; its re-kick chain re-drives it after
  the claim TTL (bounded re-kicks), and the boot sweep backstops at the next
  restart. A turn body that reduces to empty relays nothing (never an empty
  message — logged, not silent). Send order
  only advances when the oldest row leaves the queue — a stuck head (retry
  backoff, a raw row awaiting the boot sweep, or a claim inside its TTL)
  stalls ONLY its thread by design (younger rows poll at ≤60s cadence until
  the head resolves), never the others; the cap applied at send time is
  pair-aware (the slice can never re-create a lone surrogate the sanitizer
  stripped — postgres jsonb law).
- Boot sweep: unprocessed outbox rows are re-enqueued AFTER adapters and the
  workers are live (same ORDER LAW as the inbound sweep), ONCE PER PROCESS —
  the 30s partial-start retry loop does not re-sweep (a fresh re-kick with a
  reset budget every 30s would make the give-up bound unreachable); a
  restart re-sweeps, which is the deploy-crash recovery path.
- Only DONE runs relay. FAILED/STOPPED runs post nothing to the channel (the
  instant ack plus the web run pill carry that state); review turns relay the
  verdict text exactly as the thread turn shows it — one response per turn.

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
- request bodies: `/auth/**` and `/rpc` read only DECLARED-length bodies — a `transfer-encoding: chunked` body with no usable `content-length` is refused `411 length required` BEFORE a byte is read (h3 buffers the whole body before any size check fires, and the bun preset allows no mid-stream cap — an undeclared body has no pre-read bound); the 1MB auth body cap and the 2MB `/rpc` procedure-input cap (`413 payload too large`) apply to the read body, and the `/rpc` gates fire before the oRPC handler decodes input (oRPC buffers the whole body in `request.json()` before any procedure middleware, so `requireSession` would never see an oversized body there). Every byte the server buffers was declared up-front and carries its own pre-read cap

### Boot seed law (no default credential, #172)

- seeding runs ONLY when the `user` table is empty (restarts never touch real accounts). Seeding REQUIRES an explicit `ADMIN_PASSWORD` (min 8 chars): when seeding is due and it is unset, boot prints the env-failure report and exits nonzero — there is NO hardcoded fallback login. The known literal `tandem-admin` is refused as a seed value the same way. `ADMIN_EMAIL` may default to `admin@tandem.local`.
- forced rotation: the seeded admin's row carries `must_change_password = true`. While the session user carries that flag, every oRPC procedure above the public tier (`auth.session`/`auth.config`/`auth.configLive`/`meta.version`/`/health/*`/`/auth/**` excepted) AND every session-gated REST route (file reads included — attachment bytes, avatars) rejects FORBIDDEN `password change required`; `auth.changeMyPassword` stays reachable — it verifies the current credential and replaces it, clearing the flag in one transaction. `auth.session` carries `mustChangePassword`, and the UI shows a single set-new-password screen for that session (minimum steps: current + new + confirm).
- test-only escape: `TANDEM_SEED_NO_ROTATION=1` seeds without the flag — the e2e/CI knob; production never sets it.

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

| tier     | who                    | surface                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public   | anonymous              | `auth.config`, `auth.configLive`, `auth.session`, `meta.version`, better-auth `/auth/**`, `/health/*`                                                                                                                                                                                                                                                    |
| session  | any authenticated user | every read procedure (list/listPaged/live/detail/thread/runs/inbox/subtasks/assignments/proposals/reviews/activity/titles/apiKeys [own employee only — see CREDENTIAL-METADATA SCOPE]), `changes.live`                                                                                                                                                   |
| employee | EMPLOYEE + ADMIN       | every `tasks.*` and `projects.*` write (create/update/setStatus/note/ask/forward/answer/submit/approve/requestChanges/reject/abandon/dispatch/remove/proposals confirm+reject) and `statuses.assign` (Jev auto-assign); verdict writes are additionally HUMAN-only (see below)                                                                           |
| admin    | ADMIN only             | vault (secrets + folders, all verbs), providers (all verbs incl. models), oidc.replace, settings.update, environments create/update/remove/probe, employees create/update/remove, access-key mint/update/revoke, statuses save/remove, mcp registry writes + bindings + probe + oauthConnect mint (registry reads are session-tier, see the MCP section) |

Wrong role → `FORBIDDEN`; anonymous → `UNAUTHORIZED`. Reads never exceed the
session tier; an admin-surface write is never wired below the admin tier. A
role gate is part of the procedure definition itself (kernel middleware), so a
router file wired with bare `protectedProcedure` on an admin-tier write is a
defect even if a client never calls it.
**CREDENTIAL-METADATA SCOPE:** credential metadata is not roster data. The
access-key read (`employees.listApiKeys`) is SELF-OR-ADMIN: a session reads its
OWN employee's keys; an EMPLOYEE/VIEWER asking for any other employee id — like
a malformed (non-uuid-shaped) id — gets `NOT_FOUND` (the id is a miss, never a
500). ADMIN reads any employee's keys. The read never returns key material; a
plaintext key appears in exactly one response class, the one-time mint
(`employees.create`, `employees.createApiKey`), by design.
**ACCESS-KEY NAME CAP:** the credential backend caps key names at 32 — its
measure is `name.length` (UTF-16 code units) — and its rejection on the
server-side mint call surfaces as an opaque 500. Every access-key name these
procedures write (`employees.create`'s initial key, `employees.createApiKey`,
`employees.updateApiKey`) is held to that cap: a DERIVED default truncates the
employee-name prefix on a code-point boundary (never the fixed suffix, never
through a surrogate pair), so it always fits; a caller-supplied name is
trimmed, refused (`BAD_REQUEST`) when it carries NUL or a lone surrogate, and
measured against the cap. A name over the cap answers `BAD_REQUEST` (`name too
long`; longer input is rejected by the schema edge with its own validation
error) — never an opaque 500. A whitespace-only supplied name mints the derived
default at `employees.createApiKey`; rename requires a non-blank name.
**LIVE-STREAM RE-AUTH (#224):** a `live` stream outlives its open-time check, so
every live generator re-asserts the procedure's own tier against a FRESH
session (never the per-request latch) before emitting a snapshot — at most once
per 5s window per stream. A revoked/deleted session → `UNAUTHORIZED`;
rotation-locked, demoted, or API-key-on-human-only → `FORBIDDEN`; the stream
tears down rather than yielding. Public streams (`auth.configLive`) skip the
check by design; a live procedure whose generator never calls the gate is a
review blocker.

**UI tier visibility (UX, never the boundary, #263):** no ADMIN-SURFACE verb renders
below the admin tier. The nav filters the admin-surface items (Vault, MCP,
Environments, Employees, Settings) to ADMIN; the Settings page renders its
admin cards (general, providers, auth) to ADMIN only — a non-admin deep link
gets a read-only "Admin only" note. Vault sits wholly in the admin tier (its
reads included), so a non-admin /vault deep link renders the load error, never
a browser; Employees, Environments and the Statuses manager read at the
session tier and render read-only for non-admin deep links — their
create/edit/delete/keys verb UI hides behind the managers' `editable` prop
wired to the session role (`useIsAdmin`). Admins see no change. The gate is
UX only — the server tier matrix above stays the boundary.

**Employee-tier render rule (#300):** no EMPLOYEE-TIER verb renders below the
employee tier. The Tasks and Projects managers gate every tasks._/projects._
write affordance behind `useCanWork` (role EMPLOYEE or ADMIN): the create CTAs
(toolbars + empty-state), the row edit/delete/auto-assign menus, the board
drag/move-to path and the project add-subproject/edit/delete actions — a
VIEWER session gets the same lists with plain status text instead of the
status select and a kebab reduced to the read-only Workflow entry. The task
detail page and its workflow drawer render their write surfaces (composer +
send, workflow verbs, forward, review box, stop/dispatch, the Details
status/assignee/project selects, proposal Confirm/Decline and Add subtask) to
EMPLOYEE + ADMIN only — below the employee tier each Details field renders its
value as plain text; the thread, runs and activity stay session-tier reads.
Employees and admins see no change. The gate is UX only — the server tier
matrix above stays the boundary.

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
better-auth's own `/auth/**` protocol, the `/health/*` infra probes, and the
Routes table's explicit exceptions — `GET /api/auth-config` (login
capabilities), `POST /api/tasks/:id/attachments` (multipart upload),
`GET /api/attachments/:id` (attachment bytes), `GET /api/employees/:id/avatar`
(avatar bytes; the three file routes are session-gated) and the MCP OAuth
flow's browser-redirect return leg `GET /api/mcp/oauth/callback`
(state-row proof; see "OAuth per binding" — the connect mint is the admin
oRPC POST `mcp.oauthConnect`, not a REST route, #278).
Rules:

- every mutating procedure publishes to the in-process change bus
  (`server/utils/change-bus.ts`, MemoryPublisher) after commit — EXCEPT the
  `mcp.oauthConnect` mint: it writes only transient single-use state rows
  with no observable surface (nothing renders or queries them), so a
  publish would needlessly invalidate MCP queries (#278)
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
- **ID-SHAPE LAW (#358):** every uuid-typed id input — an id that lands in a
  uuid-typed column — is shape-checked against the canonical wire form
  (`shared/utils/is-uuid.ts`) at the handler edge, before any query builder
  sees it. Outcome by surface, never per call site: a READ / lookup answers
  `NOT_FOUND` (a malformed id is a miss, never a 500); a WRITE answers
  `BAD_REQUEST` for every uuid id it stores or scopes by (target, assignee,
  owner, reviewer, employee) — a malformed id is malformed input, never a
  claim that a row is missing; a LIST FILTER short-circuits to the specced
  empty page (a filter is not a lookup). A raw non-uuid string must never
  reach a uuid column: Postgres raises 22P02 ('invalid input syntax for type
  uuid') and the client would see a 500. Writes also answer `BAD_REQUEST` when
  a referenced assignee/owner does not exist. `mcp.probe` is a LOOKUP surface:
  its `{employeeId, serverId}` names an existing binding and a malformed id is
  the same `NOT_FOUND` a well-formed id with no binding answers (the persisted
  verdict writes no caller-supplied id); `mcp.bindingsRemove` deletes the
  binding, so it is a write and answers `BAD_REQUEST`. Text-typed ids (task,
  project, status, registry, environment, vault ids) are outside THIS law —
  they cannot raise 22P02, so a malformed value is an ordinary miss. Every
  text-typed id parameter is, however, inside the TEXT-STORABILITY LAW (#386):
  on every oRPC procedure input a READ key, WRITE target, store key and
  LIST-FILTER alike refuse NUL and unpaired surrogates at the procedure's edge
  with the field-named `BAD_REQUEST` (`storableId` / `storableIdRef` in
  `shared/utils/storable-text.ts`) before any query builder sees them. (The
  REST file routes — attachment upload/download — read ids from the path and
  are outside this law; their handlers own the shape check.) The sweep covers every task id (`id`, `taskId`, `parentId`,
  `projectId`, `assigneeId`, `ownerId`, `reviewers[]`, `proposalId`, `runId`,
  `toEmployeeId`, `before.id`, and the `status` / `statusId` references),
  project (`id`, `parentId`), task-status (`id`, `nextIds[]`), model-provider
  (`id`, `providerId`, `keySecretId`), vault (`id`, `folderId`), environment
  (`id`, `secretId`), MCP registry / binding (`id`, `employeeId`, `serverId`,
  `secretId`, `oauthClientSecretId`), channel config (`tokenSecretId` and a
  binding's `platformUserId`), the OIDC provider registry (`id` — a store key
  whose corrupted value would mint a NEW provider) and settings assignment
  references (`providerId`, `model`, `keySecretId`). An id-named leaf that is a
  CREDENTIAL value (`oauthClientId`, an OIDC `clientId`) is not a row key and
  stays inside the TEXT-STORABILITY text rule instead. The refusal must not be left to the
  comparison shape: an id compared in JS against a loaded set (`tasks.create`
  status; `statuses.save` nextIds — its set is the loaded ids PLUS the
  incoming id) or shape-checked before any query already answers `BAD_REQUEST`
  for unstorable bytes, but an id that reaches a query parameter does not — a
  NUL raises at the driver before the lookup can miss, a lone surrogate is
  rewritten to U+FFFD and the read misses on a corrupted value, and the two
  upsert-by-id writes (`statuses.save`, `providers.save`) would create a NEW
  row under the corrupted id. Outside the storable class, a malformed non-uuid
  value keeps each surface's own ID-SHAPE answer (the employee procedures stay
  inside that law).
- **TEXT-STORABILITY LAW (#377/#382):** user-supplied text written to a
  Postgres text column must be STORABLE — `NUL` (0x00) and unpaired surrogates
  are refused at the procedure's edge (`BAD_REQUEST`; the message names the
  field and the class: 'invalid characters (NUL or a lone surrogate)'), never
  handed to the driver. The refusal rides the shared predicate and field-named
  message (`shared/utils/storable-text.ts`: `hasUnstorableText`,
  `unstorableMessage`, `storable`, `storableText`, `storableOptionalText`) on
  every free-form field. Outside a schema edge, the pre-existing access-key name
  guard (handler-level) and better-auth's `user.create` / `update-user`
  database hooks reuse the same predicate, and the vault last-four hint is
  derived with a code-point slice (never a UTF-16 cut). This law covers
  USER-supplied text at write-surface edges (oRPC procedure schemas and
  better-auth's own user create/update hooks) only: agent-supplied text
  (proposal envelopes, run output, transcripts) is machine text and outside
  it. A NUL
  makes the driver throw
  (invalid byte sequence) and would surface through oRPC as an opaque 500 on
  input the schema had accepted; an unpaired surrogate is WORSE — the driver
  rewrites it to U+FFFD, so the stored value is silently corrupted. A
  well-formed surrogate pair (an astral character) IS storable and stays
  accepted. Covered write surfaces: employees (`create` / `update` name, title,
  instructions, model and the avatar `image` data URL, plus every text-typed id
  those procedures accept, `titles.save` / `titles.remove` and the catalog
  `name`); tasks (`create` / `update` title and description, every thread body
  from `note` / `ask` / `forward` / `answer` / `submit` / `approve` /
  `requestChanges` / `reject` / `abandon`, and the proposal decision `note`);
  projects (name, description, prompt); task statuses (name); vault (secret
  name, description and the secret value whose last-four hint is stored raw;
  folder name); environments (name); model providers (label, notes, `baseUrl`,
  `extraHeaders` keys and values); MCP registry (name, notes, command, `url`,
  `oauthAuthorizeUrl` / `oauthTokenUrl` / `oauthRevocationUrl`,
  `oauthScopes`, `oauthClientId`); settings free text (companyName,
  companyPrompt); and better-auth's own user create/update paths (`user.create`
  — first-user sign-up and first OIDC login — and `update-user`) for `name` /
  `image`. Search/filter `q` values on the paged list procedures (tasks,
  employees, environments, vault secrets and folders) refuse it too — a NUL
  filter reaches the driver as an `ilike` parameter and 500s the list. The
  format-guarded text columns (`email` under `z.email`, ssh host and username,
  executable, port) refuse a NUL by their own shape and never reach the
  driver; a URL's shape check does NOT (zod's `z.url()` and the MCP/`baseUrl`
  refinements only prove the scheme — `new URL()` percent-encodes a NUL in the
  PATH while the RAW input is what gets stored), so every URL column rides the
  shared refinement. Values stored inside a JSON encoding in a TEXT column
  (flags, channel configs, mcp `args`, workspace AI assignments) are storable
  by construction — the JSON escape writes `\u0000`, not a raw NUL — so the
  STORAGE half is out of scope; an id-named value inside one that is read back
  and used as a query parameter or a store key (channel `tokenSecretId`, a
  binding's `platformUserId`, assignment `providerId` / `keySecretId` — `model`
  rides the same sweep for uniformity) is still refused at the edge by the ID
  sweep above. provider `extraHeaders` keys and values are the exception
  because they are applied verbatim to outbound HTTP request headers. `jsonb`
  columns are NOT covered by that encoding argument: jsonb rejects the
  `\u0000` escape itself, so inbound channel payloads keep their own VALUE
  sanitization (object keys are not walked today — tracked separately).
- input validation: zod `strictObject` everywhere (unknown keys rejected)
- wire format: POST `/rpc/<path>`, body `{ "json": <input> }`,
  `content-type: application/json`; responses `{ "json": <result> }`

### Procedures (complete list)

| procedure                  | auth    | input                                                     | result                                                                                              |
| -------------------------- | ------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `meta.version`             | none    | —                                                         | `{version}`                                                                                         |
| `changes.live`             | session | —                                                         | SSE stream of `{resource, action}` change events (post-load invalidation only — never carries data) |
| `auth.config`              | none    | —                                                         | plain GET `{passwordEnabled, oidcEnabled, providers:[{id,label}]}`                                  |
| `auth.configLive`          | none    | —                                                         | live `{passwordEnabled, oidcEnabled, providers:[{id,label}]}`                                       |
| `auth.session`             | none    | —                                                         | session payload or null                                                                             |
| `settings.live`            | session | —                                                         | live `{disablePasswordLogin, flags}`                                                                |
| `settings.update`          | admin   | `{disablePasswordLogin?, flags?}`                         | `{ok}` (400 when disabling with no OIDC provider; 400 on flag-name/flag-count violations)           |
| `oidc.live`                | session | —                                                         | live provider list with `hasSecret`, never secrets                                                  |
| `oidc.replace`             | admin   | `{providers:[{id?,label,issuer,clientId,clientSecret?}]}` | `{ok,count}` (secrets write-only; ids server-generated for new providers)                           |
| `environments.live`        | session | —                                                         | live snapshot of all environments                                                                   |
| `environments.create`      | admin   | `{name,host,port?,username}`                              | created row                                                                                         |
| `environments.update`      | admin   | `{id,name,host,port?,username}`                           | updated row                                                                                         |
| `environments.remove`      | admin   | `{id}`                                                    | `{ok}`                                                                                              |
| `environments.probe`       | admin   | `{id}`                                                    | `{ok,detail,durationMs,lastProbeAt}` (verdict persisted on the row)                                 |
| `mcp.registryList`         | session | —                                                         | `{data:[…registry rows + bindingCount]}`                                                            |
| `mcp.registryCreate`       | admin   | `{name,url,notes,authKind?,oauth*}`                       | created row (oauth validation per "OAuth per binding")                                              |
| `mcp.registryUpdate`       | admin   | `{id,name?,url?,notes?,authKind?,oauth*}`                 | updated row (changed OAuth config wipes tokens + verdicts atomically)                               |
| `mcp.registryRemove`       | admin   | `{id}`                                                    | `{ok}`                                                                                              |
| `mcp.bindingsList`         | admin   | `{employeeId}`                                            | `{data:[…binding rows, masked secret + oauth status]}`                                              |
| `mcp.bindingsListByServer` | admin   | `{serverId}`                                              | `{data:[…binding rows + employee name, masked secret + oauth status]}`                              |
| `mcp.bindingsSet`          | admin   | `{employeeId,serverId,secretId?}`                         | binding row (upsert)                                                                                |
| `mcp.bindingsRemove`       | admin   | `{employeeId,serverId}`                                   | `{ok}` (unbind = revoke at next dispatch; oauth grants revoke best-effort)                          |
| `mcp.probe`                | admin   | `{employeeId,serverId}`                                   | `{ok,detail,durationMs,lastProbeAt}` (verdict persisted on the binding)                             |
| `mcp.oauthConnect`         | admin   | `{employeeId,serverId}`                                   | `{connectUrl,serverName}` (mint: single-use state row + provider authorizeUrl; no GET mint route)   |

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
| `environments.probe`  | `{id}`                          | `{ok,detail,durationMs,lastProbeAt}`     |

- names unique (409 on clash, including rename onto another row)
- PROBE VERDICT LAW (#178): every probe result — success AND failure — is
  persisted on the environment row (`last_probe_ok`, `last_probe_detail`,
  `last_probe_at`; null = never probed) and the environments manager renders
  the Status column from that persisted row data: a verdict survives reload
  and navigation with zero clicks, and a manual probe is a re-check that
  refreshes it. create/save never probe — a fresh row reads "Not probed"
  until the first probe. An update that changes a connection field (host,
  port, username, secretId, secretUsage) clears the verdict (a stale OK on a
  changed target would lie); a name-only edit keeps it. Probes are
  independent per row — no serialized one-at-a-time lock.
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
3. no users & `user` rows → seed admin (`ADMIN_EMAIL` default `admin@tandem.local`, `ADMIN_PASSWORD` REQUIRED — no default, `tandem-admin` refused; missing → env-failure report + exit 1; the seeded row carries `must_change_password = true`); seed never runs when users exists (SPEC "Boot seed law")
4. password stored as better-auth scrypt (`salt:hash`, no prefix label)

## UI laws

- Task list inline assignee (#333): the Assignee cell in the desktop list and the
  assignee line on mobile/board cards are one control — an employee-tier select
  running `tasks.update` with the same optimistic display, busy gate and live-run
  lock as the status select; a VIEWER session reads the name as text.
- Modals (UModal) size app-wide via `app/app.config.ts` — mobile keeps the library
  default `w-[calc(100vw-2rem)]` card; desktop grows with the viewport
  (`sm:max-w-xl md:max-w-2xl lg:max-w-3xl`) instead of the stock 512px `max-w-lg`.
  No per-modal width pins; the environments delete-confirm pin was removed for uniformity.

## Routes table

| method   | path                         | auth                         | purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET | `/auth/**`                   | public (policy gates inside) | better-auth handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET      | `/health/live`               | none                         | liveness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET      | `/health/ready`              | none                         | readiness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET      | `/api/auth-config`           | none                         | login capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST     | `/rpc/**`                    | varies (see API law)         | all application procedures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST     | `/rpc/**`                    | session (oRPC middleware)    | oRPC v2 procedures (see API law)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST     | `/api/tasks/:id/attachments` | employee                     | multipart attachment upload (REST exception, like avatar) — a WRITE: anonymous → 401, rotation-locked → 403, VIEWER → 403; 20MB file cap enforced pre-parse on the request body — declared length rejected pre-read, undeclared-length (chunked) bodies refused `411 length required` pre-read (no pre-read bound exists), buffered length before parse (1MB multipart-overhead allowance); ≤20 input attachments per task → 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET      | `/api/attachments/:id`       | session                      | serve attachment bytes (etag = sha256, 304 revalidation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET      | `/api/employees/:id/avatar`  | session                      | serve employee avatar bytes (REST exception)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET      | `/api/mcp/oauth/callback`    | state-row proof (no session) | OAuth per binding: consume the single-use state, exchange the code server-side, store the binding's tokens, render the close-this-window result page — the state row IS the authorization proof (#270 slice 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET      | `/mcp`                       | session (verbs admin-gated)  | MCP registry manager (registry CRUD + probe law; per-server binding manager — bindings live here AND in the agent editor, "Binding surfaces")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET      | `/`                          | none                         | 302 → `/admin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET      | `/tasks`                     | session                      | task list/board (mobile-first cards; titles link to the task page; every card kebab carries Workflow opening the same workflow drawer as the desktop row button (the drawer's verbs obey the same server-truth gates as the task page — #209: Dispatch now renders only where the server accepts dispatch) — the drawer is reachable at phone widths with ≥44px tap targets; the List/Board view toggle is pinned OUTSIDE the toolbar's right-aligned action scroller — always visible at phone widths, ≥44px tap targets, no horizontal scrolling to reach it; every horizontally scrollable control row in the toolbar area (the status filter strip and the toolbar action scroller) carries a right-edge scroll affordance (fade mask — a clipped trailing control reads as scrollable, never as broken) and every control in them (status tabs, Decisions/Awaiting chips, toolbar buttons) exposes a ≥44px touch target at phone widths, visual size unchanged from sm up) |
| GET      | `/tasks/:id`                 | session                      | task info page: chat thread (brief, run turns with raw input/output folds, activity) + sidebar (details, review checklist, routing proposals, contextual verbs) + composer; data loads via GET procs and refetches on change events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Testing contract

- vitest unit suite: one disposable Postgres database per test file, created/dropped in `afterAll`; real migrations, real better-auth, real h3 events (real `createEvent` + a fake node req with body chunks)
- coverage gates: 100% statements/branches/functions/lines; barrel/re-export files type-only modules and test-only modules are excluded
- Playwright e2e: a built server against a dedicated `tandem_e2e` database; covers login, bad password, OIDC settings round-trip, health, gates
- unit tests are order-independent: `sequence.shuffle` stays on, and every `vi.hoisted` holder is snapshotted when a test starts and restored when it ends, so a test's writes never reach the next one — writes made in `beforeAll` (or at module scope) are file state and persist for the rest of the file (test/hoisted-isolation.ts, installed by test/setup.ts); restoration is identity-preserving (containers and fixtures are put back in place; getters, readonly fields and class-instance internals are left alone) so mocks that captured a holder's references keep working; state the harness cannot reach — `WeakMap`/`WeakSet` contents, frozen objects, writes that land after the test ends (timers, unawaited promises), and tests running concurrently over one holder — is file state, and a residue assertion must live in the same test that produced it (#346); module-level mutable state in a test file (`let` bindings and top-level mutable containers outside `vi.hoisted`) is reset for every test in that file: either an explicit reset in the file's `beforeEach` (including mock call history), or assign-before-use by construction — every test that reads the state assigns it first — and a residue from a prior test is a defect (#346)
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

### Probe versioning (10-min watchdog)

- The 10-min production probe is versioned at `scripts/tandem-prod-probe.sh`
  and is the source of truth for every prod check. The agent-profile copy is a
  deploy of that file (copied, never edited in place); `origin/dev` vs live
  drift is an ops defect the critic alerts on.
- The dead-round wedge arm covers BOTH review-flow-owned shapes with the SAME
  current-round predicate (one copy of the ownership test, the round/verdict
  clauses repeated per branch and count-pinned): the task's CURRENT round
  (`max(round)`) holds NO PENDING row at all — a NULL-reviewer void row counts as
  an unsettled row whose owner settles it (the removal/boot heals for an in_review
  task, the block restore for a blocked one; the arm's silence is a declared
  choice, not a liveness claim) — holds at least one VERDICT row
  (`APPROVED` / `CHANGE_REQUESTED` / `REJECTED`), and takes NO OWNER STATUS WRITE
  newer than that round's newest verdict. The owner-status clause is the
  manual-freedom test (#430): every move of the repo's arbitrary-status surface — the
  sidebar / list / board-drag verbs, all of which ride `tasks.setStatus` — records an
  activity row (`task_messages`) whose body is
  `status: <from> → <to>` (the only writer of that body in the codebase; the workflow
  verbs — submit, answer, abandon, create — move status through their own paths and
  mint/close rounds, and none leaves an in-review task over a decided round without a
  PENDING row) — so a
  legal re-queue into an in-review status over an already-decided round always
  carries its move NEWER than the verdict (for every move made since the activity
  store existed), while machine status writes (the gating
  auto-block and auto-unblock, a park, the settle flip) log their own bodies and
  can never borrow a manual move's shape; a task-row write that is NOT an owner
  status write (the child-restore that lands the task back in review, a
  title/assignee edit) no longer masks the shape either. Free text cannot forge the
  row: the 1:1 activity payload must carry `kind = 'STATUS'` (a note or a human
  reviewer's body that merely starts `status: ` is not a status write), and
  `tasks.setStatus` commits the row in the SAME transaction as the status write
  (OWNER-MOVE RECORD law), so a landed owner move always carries it. The term is
  VERSION-GATED at the atomic-writer floor (2.78.24): the absence of a record is
  decisive only where the server guarantees every landed move carries one, so an older
  image keeps the retired verdict-vs-write ordering (a crash before the pre-floor
  writer's log could lose the row — maskable, but never a false alarm) and only a
  2.78.24+ image is judged by the owner record. The body, not
  the author, is the key: `author_id` is ON DELETE SET NULL, so a deleted mover's
  row would read as a machine write. The
  verdict ROW still commits before the flip's conditional task write, so a lost
  settle flip leaves exactly this shape: the round closed with a verdict and no
  owner move after it. The shapes are (1) an `in_review`-category task, and
  (2) from 2.78.20, under the same origin-column and version gates as the other
  #419 arms, a PAUSED gating auto-block (`park_from_status IS NULL`,
  `pre_block_status` resolving to an `in_review` category). A `park` clears the
  gate origin in the SAME write that sets `park_from_status`, so a parked row
  matches neither branch — a parked round that closed is either a designed
  settle-failure recovery or the same lost flip, and telling them apart is OUT of
  this arm (#431); a non-settle block egress (#427) leaves the origin pointing at a
  NON-REVIEW status (a cancel that re-blocks records the cancelled status), so the
  origin resolve excludes them, and an origin that no longer RESOLVES (its status
  was deleted after the block recorded it) is covered by the ORPHAN-HOME arm below
  (#432). The owner-status term reads `task_messages.task_id` / `body` /
  `created_at` and `task_message_activities.message_id` / `payload` (probe law #5:
  the column names are verified against the live schema, and the arm rides
  `task_messages_task_idx`).
- The ORPHAN-HOME arm (#432) reads the shape the wedge's block branch cannot: a
  PAUSED row where EITHER recorded origin (`pre_block_status` or `park_from_status`)
  names NO `task_statuses` row — its status was deleted while it homed a block — and NO
  recorded origin of that row resolves into review (a resolvable park home still lets
  the settle flip land, so such a row is not this shape: the wedge's park exclusion,
  mirrored), with the wedge's current-round clause (no PENDING row in `max(round)`,
  at least one verdict row) plus its own verdict-vs-write ordering (the newest verdict
  of that round NEWER than the task's last write — this arm keeps the simpler `updated_at`
  test; the wedge's owner-status discriminator is #430's).
  The dangling test is PER COLUMN (a row carrying both origins still fires when one of
  them lost its row). No ORDINARY write path produces it: a gating block records the
  task's own status (a row that exists at write time), a park records an in-review home,
  a hand-made block clears both origins, and `statuses.remove` re-homes every recorded
  reference inside the delete's own transaction (STATUS-ORIGIN MEMORY LAW) — the one
  residual producer is the ghost-task race that law declares (a task moved into the
  status while it was being deleted), and the shape is outside every other arm's origin
  resolve. The arm is VERSION-independent (no image
  floor: a pre-guard image still produces the strand) but COLUMN-gated exactly like
  the block branch — it reads both origin columns, so it is emitted only at the
  two-column gate and VANISHES without `park_from_status` (an arm referencing a
  missing column would kill the whole UNION and blind every arm, #325).
- `--strand-sql <version> <origin-column-count>` prints the exact strand-shape
  SQL a pass would run for that gate pair (no network, no state writes — the
  probe's state directory is created only after both pure dispatch modes exit),
  so the arms' regression test executes the bytes that ship rather than a
  test-side copy; `--selfcheck` asserts both ownership predicates and, on the
  WEDGE arm alone (never the whole strand SQL, where the ownership predicate is
  echoed by other arms), the block branch's presence/absence at the version gate
  and, counted per branch (never a whole-SQL substring, which other arms satisfy),
  the current-round live-round clause, the verdict status list, the verdict round
  binding and the owner-status discriminator (present in both branches, and the
  retired `updated_at` ordering absent from the wedge slice).
- The EGRESS-ORIGIN arm (#427, floor 2.78.25) reads the shape every legal egress must
  leave behind: a task whose status category is NOT `paused` while it still carries a
  gating origin (`park_from_status` or `pre_block_status`). After that release no egress
  can produce it — the settle's two flips, the owner's manual move, `abandonTask`, the
  note-dispatch bounce and the idle-liveness bounce all clear both origins (and reset the
  park re-arm ledger) in the SAME statement that lands the status. Nothing heals such a
  row: every gating discriminator resolves those columns on a paused row only, so the next
  auto-block overwrites the home and a later park inherits a home it never recorded. The
  admin fixup (`statuses.remove`) reaches it only on a DELETE and only on its no-faithful-
  home branch: deleting a `paused`-category origin clears it on every non-blocked row,
  while deleting an origin that HAS a same-category sibling re-homes it instead, leaving
  the shape (and the alert) intact. The idle-liveness bounce clears it too — but only for
  AI-assigned working rows, since the sweep's scan joins `ai_employees` — so a human-
  assigned leftover is never reached. Keyed on the ORIGINS alone, never the ledger: the block's OWN resume legally leaves the attempt
  ledger on a live row (#211 bounded cycles), so a ledger term would alert on a healthy
  row. NOT timestamp-scoped on purpose: `updated_at` is the row's last write, not the
  egress wire — any benign edit bumps it, so a scope keyed on it would alert on a pre-fix
  leftover touched once and drown a real regression. The floor bounds WHEN the arm can
  speak; it does not classify a row. A pre-fix leftover that survives into a floored image
  therefore alerts on every pass until a human clears it (an AI-assigned working-category
  one excepted: the idle-liveness bounce clears it at the next tick past its grace) — an
  accepted, one-time cost: the arm cannot tell that leftover from a live egress failure,
  and a missed regression is the worse error.
- The READY-ROUND arm (#443, floor 2.78.26; task-wide per #445) reads a `ready`- or
  `working`-category task that owns a PENDING row of ANY round for a LIVE AI reviewer
  (`ai_employees.user_id`; a NULL-reviewer void row is a non-vote, #365), with NO
  `RUNNING` run on the task and the row past the arm's own 5-minute grace on the row's
  OWN age — comfortably beyond any legal commit→dispatch window, and keyed on the row
  (not the stalled-review sweep's never-dispatched-run clause, which must not ride this
  arm; see the reader-scope note below) — AND WITHOUT an owner status write (the
  `status: …` body with the
  `kind = 'STATUS'` payload, the `tasks.setStatus` signature) newer than that row. The
  owner clause is the manual-freedom exception: the manual surface never tears a round
  down, so a move out of review legally leaves the round's PENDING rows behind, and its
  own move row is always newer than the rows it stranded; every machine flip that returns
  a task to a ready category logs its own body and can never borrow that signature. The
  law is TASK-WIDE: a ready task must own no live round at all — pinning the arm to the
  CURRENT round (`max(round)`) hid an older-round strand (a resubmit opens the next round
  insert-only and older rows are never superseded, so a teardown regression leaving ONLY
  non-current-round rows alerted never, #445), and the clause is retired from the arm's
  bytes. BOTH exclusions are PER-ROW: keyed on each row's own `created_at`, evaluated per
  round, never per task. The
  HOLD-LANDING exception is the one other legal shape the review section declares: an
  answer that lands while a verdict is held, and whose repair flip loses the dispatcher's
  claim, leaves the re-opened round on a ready/working status with only a
  `review round resumed …` thread note (a machine body with the 1:1 `kind = 'STATUS'`
  payload, written after the row it re-opened — the re-open keeps `created_at`), so the
  arm excludes any row a resume note is newer than; free text cannot forge either
  exclusion (a NOTE's payload kind is `NOTE`), and a verdict record (the round's own
  decision, `kind = 'VERDICT'`) is not an exclusion record — an older-round strand under
  a decided newer round fires. The residual producers the arm's floor leaves are named
  exhaustively: every legal flip either supersedes the rows it strands (the egress
  teardown, terminal settles, `no live reviewers`) or writes a newer STATUS-kind record;
  the escalation replacement mint targets a live round on an in_review task, never this
  scope; a verdict bounce cannot strand its own round's siblings — the round matrix
  returns `waiting` and never flips while any PENDING row of the deciding round remains,
  so the flip proceeds only on the round's LAST verdict and strands nothing it decided;
  what a bounce CAN strand is a NEWER round's live rows when a stale AI verdict binds to
  the older round it was dispatched for — the flip is a raw write (no note), so those
  rows land unrecorded and the arm's firing on them is the law, not a false positive.
  Below the floor the note-dispatch bounce itself produces the shape (a parked round
  left behind by a legal send), so the arm stays
  silent there — a pre-fix image cannot heal it and an alert would misattribute cause. From
  the floor every dispatch flip tears its open rounds down in the same transaction (SPEC
  COMPOSER LAW, NOTE-EGRESS ROUND TEARDOWN), so a surviving count is a guard regression or
  a direct-SQL write. Not reader-scoped: the parked reviewer WAS dispatched this round (its
  turn failed), so the stalled-review sweep's never-dispatched clause must NOT ride this
  arm — it would exclude the exact shape. The floor bounds WHEN the arm can speak; the
  residual producers it names are then exhaustive BY DECLARATION: a guard regression, a
  direct-SQL write, or `statuses.save` recategorizing a status a ready task sits in (the
  admin surface can legally move a task's category under it — an alert there is correct
  and the recategorization is the evidence, not a false positive).
- The probe's CT SSH target and local profile/state paths are env-overridable
  with today's production values as defaults (`TANDEM_CT_KEY` / `TANDEM_CT_ADDR`,
  `TANDEM_PROFILE_DIR`, `TANDEM_PROBE_STATE`); the public URL and container names
  remain fixed production constants — the overrides relocate legs for inspection,
  they are not a test mode. `scripts/check-probe-drift.sh` fetches `origin/dev`
  with an explicit refspec before comparing (a stale ref cannot green-light
  drift) and is the drift check the critic runs (exit 0 = live copy ==
  `origin/dev`; its tests retarget the live path with `TANDEM_PROBE_TEST=1`,
  where a successful comparison exits 3 — never 0).
