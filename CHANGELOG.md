# [2.38.0](https://github.com/namhtpyn/tandem/compare/v2.37.5...v2.38.0) (2026-10-21)


### Features

* **db:** Bun SQL driver — drizzle-orm/bun-sql replaces postgres-js ([45acae4](https://github.com/namhtpyn/tandem/commit/45acae43f3088774be96d35f157cbb4bfb398986))

## [2.37.5](https://github.com/namhtpyn/tandem/compare/v2.37.4...v2.37.5) (2026-10-21)


### Bug Fixes

* **db:** prod-shaped migration repair — drop short-named FKs before the uuid remap, copy the legacy ledger instead of renaming so rollback to the old image still boots ([3bf034b](https://github.com/namhtpyn/tandem/commit/3bf034b721772dbcba04685557954da99ba367c2))

## [2.37.4](https://github.com/namhtpyn/tandem/compare/v2.37.3...v2.37.4) (2026-10-21)


### Bug Fixes

* **tests:** restore closing braces in sse-law-composable ([41cded3](https://github.com/namhtpyn/tandem/commit/41cded3b747635404b602a63e6ce608fb5f10b7e))

## [2.37.3](https://github.com/namhtpyn/tandem/compare/v2.37.2...v2.37.3) (2026-10-21)


### Bug Fixes

* **ci:** unit tests pointed at redis 6379 — the service maps 6399 ([58c182e](https://github.com/namhtpyn/tandem/commit/58c182e449df4f8fb506496ce8cbcd5680c062f4))

## [2.37.2](https://github.com/namhtpyn/tandem/compare/v2.37.1...v2.37.2) (2026-10-21)


### Bug Fixes

* **kernel:** redis boot ping timeout 1500 → 5000ms — coverage-instrumented runs exceeded 1.5s ([c9915d8](https://github.com/namhtpyn/tandem/commit/c9915d80753387bec60068b3317481347f5d20a2))

## [2.37.1](https://github.com/namhtpyn/tandem/compare/v2.37.0...v2.37.1) (2026-10-21)


### Bug Fixes

* **tests:** finish the merge-era suite repair — 618/618 ([048a1fa](https://github.com/namhtpyn/tandem/commit/048a1fa46c9718873d4832c960b23575bc0b6c14))

# [2.37.0](https://github.com/namhtpyn/tandem/compare/v2.36.0...v2.37.0) (2026-10-21)


### Bug Fixes

* **auth:** role enum SCREAMING in the auth config — the floating auth CLI drifted to lowercase output ([452a3d0](https://github.com/namhtpyn/tandem/commit/452a3d0e0688a34acb5bf1c94e9144524ff48f81))
* **build:** shared/run-verdict via the #shared alias in app utils ([642ef0d](https://github.com/namhtpyn/tandem/commit/642ef0dfe990c11ba4dc0b8c351290b6c3e63101))
* **db:** legacy-id remap mints uuidv7, not gen_random_uuid ([d8f6802](https://github.com/namhtpyn/tandem/commit/d8f6802e72267b95f0f08263a2df704c2f6d6dc7))
* **deps:** oRPC beta.44 for vue-query 5.104.3 typing; coverage for outputSchema arm ([b2332ed](https://github.com/namhtpyn/tandem/commit/b2332ed4defc74f71c36287f34783c3062447551))
* **deps:** pin @types/bun 1.4.3 — tsconfig types:['bun'] had no lockfile entry ([9d67253](https://github.com/namhtpyn/tandem/commit/9d67253d552c3d88ceaa8a0dd4dff7ca1d9f2f6b))
* **deps:** restore the kernel deps the merge dropped (redis stack, cache-manager, oxlint) ([885f923](https://github.com/namhtpyn/tandem/commit/885f923572a24113518c793547c53297df4b647d))
* **e2e:** gating spec matches the status NAME (ids are uuids now) ([eb48ddb](https://github.com/namhtpyn/tandem/commit/eb48ddb59dcbd866b2934d68a2f46afba8e6dddc))
* **tasks:** gate runs/activity/reviews queries with enabled flag, not skipToken ([bec5599](https://github.com/namhtpyn/tandem/commit/bec559985e1b520baee4c8508e3cf04a07d8d912))
* **test:** same-millisecond note/run timestamps are admissible ([acd9d0a](https://github.com/namhtpyn/tandem/commit/acd9d0a40fe25ef7016c4eeae5528b861a3b581e))
* **ui:** description editor renders with input chrome + min height ([64278e9](https://github.com/namhtpyn/tandem/commit/64278e92fcab54d9e671affcaf4a488b62c92fce))
* **ui:** every capped modal gets a scrolling body — editors no longer clip ([708d9e6](https://github.com/namhtpyn/tandem/commit/708d9e6f4193ba24fbaaa159fd373a264003a1b8))
* **ui:** key mobile rows by id, not title value ([2a9a480](https://github.com/namhtpyn/tandem/commit/2a9a480bfab5adca51bad0c35ba24c3cf4c5997b))


### Features

* **app:** vue-query SSR — dehydrate/hydrate + onServerPrefetch ([e126bdd](https://github.com/namhtpyn/tandem/commit/e126bdd16c331f3d1c25bf7810d22bbd1a0ecb77))
* **db:** better-auth ids become native uuid columns ([ce5875b](https://github.com/namhtpyn/tandem/commit/ce5875b944cc6b2483102ccbb6bc2d8e4ee6101e))
* **db:** count + findManyAndCount on relational query builder ([5cceaa1](https://github.com/namhtpyn/tandem/commit/5cceaa1b639c7b487ac060804b8aeb570a3ebc1a))
* **db:** drop the tandem_ table prefix estate-wide ([12093fd](https://github.com/namhtpyn/tandem/commit/12093fd7b07b8958f836d80217490475d6dbd9df))
* **db:** schema.ts mints ids and timestamps at the app, like schema.auth.ts ([931df16](https://github.com/namhtpyn/tandem/commit/931df16ad6b0b03999a4bf64c6403af0249b1444))
* **db:** vault_audit.at -> created_at; DB defaults converge to nothing ([d476ab3](https://github.com/namhtpyn/tandem/commit/d476ab34c2e7a50b9c203764fd717080111285f0))
* **editor:** paste or drop images into task descriptions as attachments ([0c9d0b4](https://github.com/namhtpyn/tandem/commit/0c9d0b4685c666b86ad28feb5df036574cdc3fd4))
* **ids:** UUIDv7 for all Tandem-minted ids ([4e02274](https://github.com/namhtpyn/tandem/commit/4e02274495318d61c3fbef46244b7aa7a87b4d0a))
* **kernel:** Redis is REQUIRED — drop null/memory fallbacks ([0cb9093](https://github.com/namhtpyn/tandem/commit/0cb90938c0006c78278df94d17de365c69680630))
* **kernel:** zod-validated env contract — fail fast at boot ([5b49597](https://github.com/namhtpyn/tandem/commit/5b49597c478105da664c1363a9ec66b9c234a506))
* **runner:** zod-validated structured verdicts replace envelope markers ([dbd14ad](https://github.com/namhtpyn/tandem/commit/dbd14ad9362287e96dcf2c2fcb18f02313f628f9))
* **sessions:** drop tasks.acp_session_id — sessions are per (task, employee) on run rows ([b759e66](https://github.com/namhtpyn/tandem/commit/b759e663856ce0c6bcd591afda60cefcfdb0c5b7))
* **statuses:** task status ids become fixed uuidv7 constants ([27bb2e7](https://github.com/namhtpyn/tandem/commit/27bb2e74cc7cf378522d0ac5d2791c73eb06accc))
* **ui:** DataTable — desktop table + mobile card list from one definition ([eaf7bd5](https://github.com/namhtpyn/tandem/commit/eaf7bd5e2402f7abb074aa6c10cb2bd9b116e22f))
* **ui:** DataTable toolbar — built-in search + slot for filters and actions ([d07a316](https://github.com/namhtpyn/tandem/commit/d07a31600dd79c69f6e00478761ac44ddbbc0b24))
* **vault:** folder filter as USelect in the table toolbar (replaces chips) ([095768a](https://github.com/namhtpyn/tandem/commit/095768a85594051cf5ffec2acf16b06c84d588e8))
* **vault:** paginated folder manager table (findManyAndCount + counts per page) ([4654111](https://github.com/namhtpyn/tandem/commit/4654111b5b18d6546cbdc4f03c5019163c0be9ca))
* **vault:** remove the audit trail ([6e524c6](https://github.com/namhtpyn/tandem/commit/6e524c6b4d423c45e265e74f69f9aff18f072ef7))
* **vault:** server-side pagination via findManyAndCount ([c3ae016](https://github.com/namhtpyn/tandem/commit/c3ae016ea37cef86c87e301aba089ee314bd9123))
* **vault:** server-side search on secrets and folders tables ([363fb6e](https://github.com/namhtpyn/tandem/commit/363fb6e5cf9af671716897ba59dade0c01c71d13))
* **verdicts:** generic structured output + no-compat JSON estate ([d8a959c](https://github.com/namhtpyn/tandem/commit/d8a959cb6e4bdcd10ddf8d094caab8078e529d06))

# [2.36.0](https://github.com/namhtpyn/tandem/compare/v2.35.1...v2.36.0) (2026-10-17)


### Bug Fixes

* **build:** shared/run-verdict via the #shared alias in app utils ([60f4e7f](https://github.com/namhtpyn/tandem/commit/60f4e7fe949a1ce69f504e08bd6109243b1172f1))
* **deps:** oRPC beta.44 for vue-query 5.104.3 typing; coverage for outputSchema arm ([51c72c1](https://github.com/namhtpyn/tandem/commit/51c72c12a1bcba7ff2a5762c72fccc1fa6e13a1c))
* **e2e:** gating spec matches the status NAME (ids are uuids now) ([b021e99](https://github.com/namhtpyn/tandem/commit/b021e9909dd5f969fdb6331a34e4c84bb41eb4eb))
* **tasks:** gate runs/activity/reviews queries with enabled flag, not skipToken ([5278a24](https://github.com/namhtpyn/tandem/commit/5278a243befd55ce5342b6d5f6c74456ec07653b))
* **test:** same-millisecond note/run timestamps are admissible ([d8fbe2e](https://github.com/namhtpyn/tandem/commit/d8fbe2e9684d7f1322806d2698ede132ebcd638c))
* **ui:** description editor renders with input chrome + min height ([04dc2a8](https://github.com/namhtpyn/tandem/commit/04dc2a86e063d3a6f85b3dfc3f78a51d9f03e39c))
* **ui:** every capped modal gets a scrolling body — editors no longer clip ([ee3d643](https://github.com/namhtpyn/tandem/commit/ee3d6433f0ba2acdb204de3f26f38d9cc8e50f45))


### Features

* **editor:** paste or drop images into task descriptions as attachments ([37cdbd8](https://github.com/namhtpyn/tandem/commit/37cdbd893bd517dd5894407bba4e82c35841a25c))
* **ids:** UUIDv7 for all Tandem-minted ids ([8b8cc21](https://github.com/namhtpyn/tandem/commit/8b8cc21c1747b50569af2b7485509ea5969cf0bc))
* **runner:** zod-validated structured verdicts replace envelope markers ([9078b85](https://github.com/namhtpyn/tandem/commit/9078b85cc28459e642504d10065ebf9db0d7d903))
* **sessions:** drop tasks.acp_session_id — sessions are per (task, employee) on run rows ([6e90262](https://github.com/namhtpyn/tandem/commit/6e90262cbc30bfc2ce12340eeccdba88a213dbb8))
* **statuses:** task status ids become fixed uuidv7 constants ([9f8de74](https://github.com/namhtpyn/tandem/commit/9f8de7432dcdc08ee05dfcb77139a9ca3f591a13))
* **verdicts:** generic structured output + no-compat JSON estate ([b235442](https://github.com/namhtpyn/tandem/commit/b235442f7b30b0648a39f9698aaac08267fc17f4))

## [2.35.1](https://github.com/namhtpyn/tandem/compare/v2.35.0...v2.35.1) (2026-10-16)


### Bug Fixes

* **e2e:** provider specs follow the no-seed baseline; harden task-picker wait ([2ef1fbc](https://github.com/namhtpyn/tandem/commit/2ef1fbc1ce0bf5a7a531a2299310876423faf94b))

# [2.35.0](https://github.com/namhtpyn/tandem/compare/v2.34.0...v2.35.0) (2026-10-16)


### Features

* **db:** squash 32 hand-written migrations into one drizzle-kit baseline ([6cfe484](https://github.com/namhtpyn/tandem/commit/6cfe48464cb1c394afeb507276a302025929a7e2))

# [2.34.0](https://github.com/namhtpyn/tandem/compare/v2.33.0...v2.34.0) (2026-10-16)


### Bug Fixes

* **runner:** ensureOutDir always fires; deleted-mid-run failure covers the bounce's missing-task arm ([557f79e](https://github.com/namhtpyn/tandem/commit/557f79ee08252f6a840aaaf6b09b1525db10e339))
* **run:** submit the REAL result body; ALWAYS pre-create the task out-dir ([30fa6e0](https://github.com/namhtpyn/tandem/commit/30fa6e09365ba35c0c5fa3760121a7a26b7512bb))


### Features

* **review:** verdict rows per reviewer per round — review ON the task, 3 verdicts ([348ad96](https://github.com/namhtpyn/tandem/commit/348ad96c0d5d61d82537dc7ef69ad725d008738f))
* **tasks:** editable assignee/project/status in task detail Details ([f1e84d1](https://github.com/namhtpyn/tandem/commit/f1e84d1f9d62586744b127141aea152676c133b9))

# [2.33.0](https://github.com/namhtpyn/tandem/compare/v2.32.1...v2.33.0) (2026-10-16)


### Features

* **review:** supervisor reviews by default — humans and AI reviewers equal ([d7ddaf3](https://github.com/namhtpyn/tandem/commit/d7ddaf3f0cc4f377d4a2732a36ee91f996596ba1))

## [2.32.1](https://github.com/namhtpyn/tandem/compare/v2.32.0...v2.32.1) (2026-10-16)


### Bug Fixes

* **dispatch:** stale-job law — worker skips ineligible tasks; jobId dedup stops duplicate stacking ([3f6197d](https://github.com/namhtpyn/tandem/commit/3f6197db8bdb93d313fbd6b12aa4d011ebe3d64f))

# [2.32.0](https://github.com/namhtpyn/tandem/compare/v2.31.0...v2.32.0) (2026-10-16)


### Features

* **brief:** layered prompts — company (Settings) + project (Projects) ride every agent brief ([cd182dd](https://github.com/namhtpyn/tandem/commit/cd182dd99db15298bb69e53d2285e01eb040b7de))

# [2.31.0](https://github.com/namhtpyn/tandem/compare/v2.30.0...v2.31.0) (2026-10-16)


### Features

* **dispatch:** per-agent parallel dispatch — tasksPerAgent setting (default 1) ([339cf77](https://github.com/namhtpyn/tandem/commit/339cf7780fcbdcdd93f8b6bba54c396128e33d4e))

# [2.30.0](https://github.com/namhtpyn/tandem/compare/v2.29.2...v2.30.0) (2026-10-16)


### Features

* **routing:** supervisor routing within own chain auto-executes — no approval ([174fabf](https://github.com/namhtpyn/tandem/commit/174fabf76fa04e0c5af03224c2d370c6d853e979))

## [2.29.2](https://github.com/namhtpyn/tandem/compare/v2.29.1...v2.29.2) (2026-10-16)


### Bug Fixes

* **runner:** [QUESTION]/[BLOCKED] envelopes park the task on the owner, never complete it ([c11b250](https://github.com/namhtpyn/tandem/commit/c11b250dd24e8b07b657827609ab70b6f19a5a3c))

## [2.29.1](https://github.com/namhtpyn/tandem/compare/v2.29.0...v2.29.1) (2026-10-16)


### Bug Fixes

* **e2e:** drawer run status asserts the drawer's own text (done, not completed) ([011996a](https://github.com/namhtpyn/tandem/commit/011996a967d7089b9c74259aad8514b462b65311))

# [2.29.0](https://github.com/namhtpyn/tandem/compare/v2.28.2...v2.29.0) (2026-10-16)


### Features

* **run output:** keep the FULL output; drop the redundant settle note ([839b925](https://github.com/namhtpyn/tandem/commit/839b925a1c2ed8d8494e67f1a4aece988d36aa24))

## [2.28.2](https://github.com/namhtpyn/tandem/compare/v2.28.1...v2.28.2) (2026-10-15)


### Bug Fixes

* **tests:** no unhandled redis/flush errors at suite exit ([9eaadc7](https://github.com/namhtpyn/tandem/commit/9eaadc78e945cee7bd4f5966c84545d911c8f34a))

## [2.28.1](https://github.com/namhtpyn/tandem/compare/v2.28.0...v2.28.1) (2026-10-15)


### Bug Fixes

* **task page:** run card is a single agent chat message ([08ac012](https://github.com/namhtpyn/tandem/commit/08ac012ea1078a196e8d4a3fff94c35289773f7d))

# [2.28.0](https://github.com/namhtpyn/tandem/compare/v2.27.5...v2.28.0) (2026-10-15)


### Features

* **settings:** agent run timeout configurable on the Settings page (no env var) ([54c8d54](https://github.com/namhtpyn/tandem/commit/54c8d5497846c7f6242c1e8952ffeb969925f25d))

## [2.27.5](https://github.com/namhtpyn/tandem/compare/v2.27.4...v2.27.5) (2026-10-15)


### Bug Fixes

* **brief:** give agents the exact per-task deliverable out-dir ([fd8da4f](https://github.com/namhtpyn/tandem/commit/fd8da4f6534012ab451be6e70297c56f74970529))

## [2.27.4](https://github.com/namhtpyn/tandem/compare/v2.27.3...v2.27.4) (2026-10-15)


### Bug Fixes

* **task page:** the brief bubble is authored by the task creator, not 'Task brief' ([f38b4f4](https://github.com/namhtpyn/tandem/commit/f38b4f49641e03c264b0b398929dd794e5e59ac3))

## [2.27.3](https://github.com/namhtpyn/tandem/compare/v2.27.2...v2.27.3) (2026-10-15)


### Bug Fixes

* **dispatch:** re-anchor historical dispatched notes before their run row ([e3cdc44](https://github.com/namhtpyn/tandem/commit/e3cdc44e04097197d7312bf3b9910719057f13bf))

## [2.27.2](https://github.com/namhtpyn/tandem/compare/v2.27.1...v2.27.2) (2026-10-15)


### Bug Fixes

* **task page:** result shows as the agent's chat bubble; dispatch note precedes the run ([bb92e54](https://github.com/namhtpyn/tandem/commit/bb92e549bfe37a524ec72c1d0852b460d26328cb))

## [2.27.1](https://github.com/namhtpyn/tandem/compare/v2.27.0...v2.27.1) (2026-10-15)


### Bug Fixes

* **task page:** mobile layout + mention rendering ([9dee960](https://github.com/namhtpyn/tandem/commit/9dee960bedd8678f40e2fa0ff0aafb17823499b2))

# [2.27.0](https://github.com/namhtpyn/tandem/compare/v2.26.0...v2.27.0) (2026-10-15)


### Features

* **ui:** run input (prompt) on the task page + status/UI trims ([2980716](https://github.com/namhtpyn/tandem/commit/29807162e34443f8a2a534f499344b8b3e03ef1e))

# [2.26.0](https://github.com/namhtpyn/tandem/compare/v2.25.2...v2.26.0) (2026-10-15)


### Features

* **realtime:** SSE law — initial data via conventional GET procs; SSE only updates after load ([ac0b7c9](https://github.com/namhtpyn/tandem/commit/ac0b7c94b4bd2bce28d2b6c6ec84451f1f7d48c0))

## [2.25.2](https://github.com/namhtpyn/tandem/compare/v2.25.1...v2.25.2) (2026-10-15)


### Bug Fixes

* **runner:** coalesce ACP chunk deltas into real lines — one word per line is gone ([dab9a49](https://github.com/namhtpyn/tandem/commit/dab9a49bc1a3ddd58063326cde83ba8c232ad3b8))

## [2.25.1](https://github.com/namhtpyn/tandem/compare/v2.25.0...v2.25.1) (2026-10-15)


### Bug Fixes

* **docker:** pin oven/bun 1.4.2-alpine bases — no floating tags ([89606c5](https://github.com/namhtpyn/tandem/commit/89606c5aec10b0502b60ca800520ea14f5be29ef))

# [2.25.0](https://github.com/namhtpyn/tandem/compare/v2.24.0...v2.25.0) (2026-10-15)


### Features

* **runner:** dispatch via ACP v1 — one session per task; per-task attachment paths ([4078b31](https://github.com/namhtpyn/tandem/commit/4078b31727d3af9efe10388ba9fc5cb203619ebb))

# [2.24.0](https://github.com/namhtpyn/tandem/compare/v2.23.2...v2.24.0) (2026-10-15)


### Features

* **ui:** desktop-sized modals via app-wide UModal theme override ([2b03a01](https://github.com/namhtpyn/tandem/commit/2b03a01f7f79765a9d2c2b5dd80bf07935c288f0))

## [2.23.2](https://github.com/namhtpyn/tandem/compare/v2.23.1...v2.23.2) (2026-10-15)


### Bug Fixes

* **deploy:** code-side runtime defaults — /tandem/** data root and Bun idle timeout 255 ([9cc838d](https://github.com/namhtpyn/tandem/commit/9cc838d2e396c355f7a6d5ae164b4770ebf53128))

## [2.23.1](https://github.com/namhtpyn/tandem/compare/v2.23.0...v2.23.1) (2026-10-15)


### Bug Fixes

* **vault:** TANDEM_VAULT_KEY is required — drop the hardcoded dev fallback ([11647ab](https://github.com/namhtpyn/tandem/commit/11647abb3b80d4ecfd96fc04068730afba8efacc))

# [2.23.0](https://github.com/namhtpyn/tandem/compare/v2.22.2...v2.23.0) (2026-10-15)


### Features

* **tasks:** task routing — pending obligations, assignee ledger, subtasks with parent gating, agent routing proposals ([95cfbd9](https://github.com/namhtpyn/tandem/commit/95cfbd9b1d0f859ae9e3201a47a93f8e04ab8477))

## [2.22.2](https://github.com/namhtpyn/tandem/compare/v2.22.1...v2.22.2) (2026-10-15)


### Bug Fixes

* **tasks:** never expose the Tandem URL or ticket link to dispatched agents ([8e97ed0](https://github.com/namhtpyn/tandem/commit/8e97ed0ad475624ba5248dd18885e0099fa10a5a))

## [2.22.1](https://github.com/namhtpyn/tandem/compare/v2.22.0...v2.22.1) (2026-10-15)


### Bug Fixes

* **tasks:** drop dead filename fallback arm for full branch coverage ([a3bb032](https://github.com/namhtpyn/tandem/commit/a3bb032792c3c640baa747f9d5cad7981531f339))

# [2.22.0](https://github.com/namhtpyn/tandem/compare/v2.21.1...v2.22.0) (2026-10-14)


### Bug Fixes

* **tasks:** satisfy strict tsgo typings in attachment routes ([5c29788](https://github.com/namhtpyn/tandem/commit/5c297886415ad98c6a558051a48a20afa0cbe130))


### Features

* **tasks:** task attachments — upload to description, SFTP push to agent, collect outputs back ([f15105e](https://github.com/namhtpyn/tandem/commit/f15105ef0195687c7229e5f2b4e53667f3ff528e))

## [2.21.1](https://github.com/namhtpyn/tandem/compare/v2.21.0...v2.21.1) (2026-10-14)


### Bug Fixes

* **tasks:** task-detail visual redesign after harsh vision QA ([27d03c0](https://github.com/namhtpyn/tandem/commit/27d03c0a60630d6c2c2b2f074728c023239398b7))

# [2.21.0](https://github.com/namhtpyn/tandem/compare/v2.20.2...v2.21.0) (2026-10-14)


### Features

* **tasks:** Paperclip-style task detail — chat thread + info sidebar ([eb5026b](https://github.com/namhtpyn/tandem/commit/eb5026b6ac44253ed074a37dcaad89192965e623))

## [2.20.2](https://github.com/namhtpyn/tandem/compare/v2.20.1...v2.20.2) (2026-10-14)


### Bug Fixes

* **docker:** .dockerignore + non-root runtime user ([df8ab0c](https://github.com/namhtpyn/tandem/commit/df8ab0cadffae43fa8ce958498205b89333dbf11))

## [2.20.1](https://github.com/namhtpyn/tandem/compare/v2.20.0...v2.20.1) (2026-10-14)


### Bug Fixes

* **build:** production server bundle targets the bun runtime ([9d7efc7](https://github.com/namhtpyn/tandem/commit/9d7efc70dfdd94e2e4042342e360bfefc66500df))

# [2.20.0](https://github.com/namhtpyn/tandem/compare/v2.19.9...v2.20.0) (2026-10-14)


### Features

* **tasks:** per-task agent brief + rich-text mentions + live-stream info page ([5b503ac](https://github.com/namhtpyn/tandem/commit/5b503acedd31db34414a5b265f9fd9989cdfddd7))

## [2.19.9](https://github.com/namhtpyn/tandem/compare/v2.19.8...v2.19.9) (2026-10-14)


### Bug Fixes

* **tasks:** scrollable run output — drawer body scrolls, taller output blocks ([4cee0d4](https://github.com/namhtpyn/tandem/commit/4cee0d4616ff3dd9a6b342144b8c5e26fec8d126))

## [2.19.8](https://github.com/namhtpyn/tandem/compare/v2.19.7...v2.19.8) (2026-10-14)


### Bug Fixes

* **tasks:** agent-portable PATH + docker-aware HERMES_HOME ([0e0661a](https://github.com/namhtpyn/tandem/commit/0e0661a902c3a821ae9877cbe85b815c7af39b6c))

## [2.19.7](https://github.com/namhtpyn/tandem/compare/v2.19.6...v2.19.7) (2026-10-14)


### Bug Fixes

* **tasks:** info page fetches runs/activity through the typed oRPC client ([b434be8](https://github.com/namhtpyn/tandem/commit/b434be89ac729ccf420d8c486c3cbcfcf18e114b))

## [2.19.6](https://github.com/namhtpyn/tandem/compare/v2.19.5...v2.19.6) (2026-10-14)


### Bug Fixes

* **tasks:** emit hermes host-derived API key env (ULTRANOMIC_API_KEY for ai.ultranomic.net) ([a1c59ee](https://github.com/namhtpyn/tandem/commit/a1c59eebf6cf2a61b604d584ae768e18c13b59d2))

## [2.19.5](https://github.com/namhtpyn/tandem/compare/v2.19.4...v2.19.5) (2026-10-13)


### Bug Fixes

* **tasks:** export the env blob (set -a) — sourced vars were shell-only, hermes saw no credentials ([654dfe4](https://github.com/namhtpyn/tandem/commit/654dfe407892a7e49dba07fc8caba9186873f131))

## [2.19.4](https://github.com/namhtpyn/tandem/compare/v2.19.3...v2.19.4) (2026-10-13)


### Bug Fixes

* **tasks:** real hermes one-shot invocation — -z prompt, --provider custom, HERMES_HOME isolation ([467deff](https://github.com/namhtpyn/tandem/commit/467deff8092eda9538e5661055695abfe64b32fe))

## [2.19.3](https://github.com/namhtpyn/tandem/compare/v2.19.2...v2.19.3) (2026-10-13)


### Bug Fixes

* **tasks:** PATH blob must use double quotes so $HOME/$PATH expand when sourced ([1603c5f](https://github.com/namhtpyn/tandem/commit/1603c5f32441ceba6c24e83be67f880d32060ca7))

## [2.19.2](https://github.com/namhtpyn/tandem/compare/v2.19.1...v2.19.2) (2026-10-13)


### Bug Fixes

* **tasks:** extend PATH in the env blob — non-interactive ssh shells can't find the agent ([ead385d](https://github.com/namhtpyn/tandem/commit/ead385d531421da348dd615e77d907def8c902f3))

## [2.19.1](https://github.com/namhtpyn/tandem/compare/v2.19.0...v2.19.1) (2026-10-13)


### Bug Fixes

* **tasks:** guard ssh2 stream.stderr — absent on some exec paths after timeout settle ([c708df5](https://github.com/namhtpyn/tandem/commit/c708df54cc3d53b2eeca59553c213899153ac1e5))

# [2.19.0](https://github.com/namhtpyn/tandem/compare/v2.18.1...v2.19.0) (2026-10-13)


### Features

* **tasks:** task info page; run errors always visible; reaper catch made testable ([c14b454](https://github.com/namhtpyn/tandem/commit/c14b454fb0da4d377c244af9500d391280934530))

## [2.18.1](https://github.com/namhtpyn/tandem/compare/v2.18.0...v2.18.1) (2026-10-13)


### Bug Fixes

* **tasks:** quote every env-blob value — multi-word titles broke sourcing (exit 127) ([d21d0bf](https://github.com/namhtpyn/tandem/commit/d21d0bf1f8d0119053ab1f8ba52a223c7cbb7daa))

# [2.18.0](https://github.com/namhtpyn/tandem/compare/v2.17.0...v2.18.0) (2026-10-13)


### Features

* **tasks:** run resilience — hang timeout, stale-run reaper, failure backoff ([49e7f5b](https://github.com/namhtpyn/tandem/commit/49e7f5b3ee92ce8640305366d399eac93257d759))

# [2.17.0](https://github.com/namhtpyn/tandem/compare/v2.16.0...v2.17.0) (2026-10-13)


### Features

* **kernel:** optional redis — bullmq dispatch queue, pub/sub change-bus, cache ([20aa70a](https://github.com/namhtpyn/tandem/commit/20aa70ad3b3bbb0fff20ece34d8c4b44ab0b35c9))

# [2.16.0](https://github.com/namhtpyn/tandem/compare/v2.15.0...v2.16.0) (2026-10-13)


### Features

* **tasks:** agent dispatcher + streamed run logs with workflow drawer visibility ([af1d474](https://github.com/namhtpyn/tandem/commit/af1d474bf431d5490332c905f2134a64f34a5913))

# [2.15.0](https://github.com/namhtpyn/tandem/compare/v2.14.1...v2.15.0) (2026-10-13)


### Features

* **tasks:** question/answer chain + unanimous review workflow ([ab7a28b](https://github.com/namhtpyn/tandem/commit/ab7a28b0a75be590bb6a49682836e7884f03aa90))

## [2.14.1](https://github.com/namhtpyn/tandem/compare/v2.14.0...v2.14.1) (2026-10-13)


### Performance Improvements

* **employees:** avatars out of the live payload via cacheable endpoint ([e9311b3](https://github.com/namhtpyn/tandem/commit/e9311b30c3022de484b2632175e4928cd521570f))

# [2.14.0](https://github.com/namhtpyn/tandem/compare/v2.13.0...v2.14.0) (2026-10-13)


### Features

* **employees:** top-down org chart + employee avatars ([eb0b892](https://github.com/namhtpyn/tandem/commit/eb0b89214212ccf3f8a62a7337ea6a3e2116f54d))

# [2.13.0](https://github.com/namhtpyn/tandem/compare/v2.12.4...v2.13.0) (2026-10-12)


### Features

* **vault:** secret pickers group secrets by folder ([d77822d](https://github.com/namhtpyn/tandem/commit/d77822dc91f411fbef1e5e89f444f6126860ef5b))

## [2.12.4](https://github.com/namhtpyn/tandem/compare/v2.12.3...v2.12.4) (2026-10-12)


### Bug Fixes

* **employees:** all graph connectors solid ([7cb02f1](https://github.com/namhtpyn/tandem/commit/7cb02f1397c0ab76adf99c47d88564064a2a58bd))

## [2.12.3](https://github.com/namhtpyn/tandem/compare/v2.12.2...v2.12.3) (2026-10-12)


### Bug Fixes

* **employees:** one box per person, dashed cross-links for extra supervisors ([e58fdf5](https://github.com/namhtpyn/tandem/commit/e58fdf5057e68d4d09da0c5a5f211665ee5e000c))

## [2.12.2](https://github.com/namhtpyn/tandem/compare/v2.12.1...v2.12.2) (2026-10-12)


### Bug Fixes

* **employees:** graph renders every supervisor edge, not just the first ([b766451](https://github.com/namhtpyn/tandem/commit/b76645185e809928c697345a79285ea15ea2a34e))

## [2.12.1](https://github.com/namhtpyn/tandem/compare/v2.12.0...v2.12.1) (2026-10-12)


### Bug Fixes

* **vault:** live folder lists, no-retype secret edits, autocomplete with create ([ee2d1df](https://github.com/namhtpyn/tandem/commit/ee2d1df5f8e594353ab25fcd68daff696ec57518))

# [2.12.0](https://github.com/namhtpyn/tandem/compare/v2.11.3...v2.12.0) (2026-10-12)


### Features

* **vault:** folders for secrets + employee title catalog, statuses-style managers ([443542e](https://github.com/namhtpyn/tandem/commit/443542ef57ae0efcf2f646ee6e90d22f77f6ece4))

## [2.11.3](https://github.com/namhtpyn/tandem/compare/v2.11.2...v2.11.3) (2026-10-12)


### Bug Fixes

* **settings:** unify models badge color, require key+model, model autocomplete ([812f370](https://github.com/namhtpyn/tandem/commit/812f3706c9b45fa80ca5dd3bb8e7888dba202c8d))

## [2.11.2](https://github.com/namhtpyn/tandem/compare/v2.11.1...v2.11.2) (2026-10-12)


### Bug Fixes

* **server:** rename modules dir to domains — server/modules is nitro-reserved ([02a0e28](https://github.com/namhtpyn/tandem/commit/02a0e28832db3dbb0860c328c35a44ee93c9b7f6))

## [2.11.1](https://github.com/namhtpyn/tandem/compare/v2.11.0...v2.11.1) (2026-10-12)


### Bug Fixes

* **ci:** release job passes a placeholder DATABASE_URL for install/build ([4caddc3](https://github.com/namhtpyn/tandem/commit/4caddc35308225b5335346db484a6e5b3bb70ee4))
* **db:** gen:auth regenerates idempotently + ci drift guard ([f681689](https://github.com/namhtpyn/tandem/commit/f681689a4ebccb241697bab5a6e4ba394dd18f9f))

# [2.11.0](https://github.com/namhtpyn/tandem/compare/v2.10.0...v2.11.0) (2026-10-12)


### Features

* **settings:** workspace ai section replaces jev endpoint field ([600955a](https://github.com/namhtpyn/tandem/commit/600955ac565625952da3535849fc2ed17e53e95f))

# [2.10.0](https://github.com/namhtpyn/tandem/compare/v2.9.0...v2.10.0) (2026-10-12)


### Features

* **providers:** endpoint registry with models group + host-root base urls ([6e86d16](https://github.com/namhtpyn/tandem/commit/6e86d168ef5eed78a1b2d0321975dfa868d043ac))

# [2.9.0](https://github.com/namhtpyn/tandem/compare/v2.8.0...v2.9.0) (2026-10-12)


### Features

* **providers:** keys never live on provider rows + prune agent/skills styles ([9817e0b](https://github.com/namhtpyn/tandem/commit/9817e0b04c39d8981a499caf41dad69587a8b2e3))

# [2.8.0](https://github.com/namhtpyn/tandem/compare/v2.7.1...v2.8.0) (2026-10-12)


### Features

* **providers:** exhaustive label maps + screaming-snake enums + real decision adapters ([a79223c](https://github.com/namhtpyn/tandem/commit/a79223c9e42c14543f4faaeb3fce3f405d4a31e8))

## [2.7.1](https://github.com/namhtpyn/tandem/compare/v2.7.0...v2.7.1) (2026-10-11)


### Bug Fixes

* **tests:** vitest resolve alias for the #shared nuxt alias ([1a52937](https://github.com/namhtpyn/tandem/commit/1a52937503a6e5fffc94bf70e85f2d6852dd4349))

# [2.7.0](https://github.com/namhtpyn/tandem/compare/v2.6.0...v2.7.0) (2026-10-11)


### Features

* **providers:** api styles as a const-object enum set per provider ([7abaea6](https://github.com/namhtpyn/tandem/commit/7abaea67e40077caa9fd0fbada97e2d539986f13))

# [2.6.0](https://github.com/namhtpyn/tandem/compare/v2.5.1...v2.6.0) (2026-10-11)


### Features

* **providers:** decision provider kind powers Jev auto-assignment ([21ea881](https://github.com/namhtpyn/tandem/commit/21ea8817f2f02f4ee51a6bb0e1a1f04a887e9850))

## [2.5.1](https://github.com/namhtpyn/tandem/compare/v2.5.0...v2.5.1) (2026-10-11)


### Bug Fixes

* **tasks:** full branch coverage for jev assign paths ([39f4517](https://github.com/namhtpyn/tandem/commit/39f45173ad1a02d5d9b92c0baf4924099dac4920))

# [2.5.0](https://github.com/namhtpyn/tandem/compare/v2.4.0...v2.5.0) (2026-10-11)


### Features

* **tasks:** status categories + Jev-powered auto-assignment ([031149a](https://github.com/namhtpyn/tandem/commit/031149a56a38f576ce9fd87c20a3d0ee4aa74de9))

# [2.4.0](https://github.com/namhtpyn/tandem/compare/v2.3.2...v2.4.0) (2026-10-11)


### Features

* **tasks:** kanban board view with custom statuses and transitions ([d627858](https://github.com/namhtpyn/tandem/commit/d627858541805fb2b3953a2b11a09d9d27a59296))

## [2.3.2](https://github.com/namhtpyn/tandem/compare/v2.3.1...v2.3.2) (2026-10-11)


### Bug Fixes

* **ui:** remove double padding on projects and tasks pages ([cbb441b](https://github.com/namhtpyn/tandem/commit/cbb441b00822b4097fa84b5dea9ec9814f600f55))

## [2.3.1](https://github.com/namhtpyn/tandem/compare/v2.3.0...v2.3.1) (2026-10-11)


### Bug Fixes

* **ui:** release hover popovers ([4ca0939](https://github.com/namhtpyn/tandem/commit/4ca09394c01a6258e21104105c54e5dcd9bb7a70))

# [2.3.0](https://github.com/namhtpyn/tandem/compare/v2.2.0...v2.3.0) (2026-10-11)


### Features

* **ui:** tooltips on all icon-only buttons + named access keys ([746bd30](https://github.com/namhtpyn/tandem/commit/746bd306fe186c46915196b6b1ef424751e15cc6))

# [2.2.0](https://github.com/namhtpyn/tandem/compare/v2.1.0...v2.2.0) (2026-10-11)


### Features

* **employees:** access keys for humans too + clearer key semantics ([eea8c78](https://github.com/namhtpyn/tandem/commit/eea8c78a874c4b9e622f017178ecd20a5f0b1a07))

# [2.1.0](https://github.com/namhtpyn/tandem/compare/v2.0.0...v2.1.0) (2026-10-11)


### Features

* **employees:** model field autocomplete from provider /models endpoint ([f2d0aa0](https://github.com/namhtpyn/tandem/commit/f2d0aa0342af886eb791efb27fa7e28091dee1a4))

# [2.0.0](https://github.com/namhtpyn/tandem/compare/v1.15.1...v2.0.0) (2026-10-11)


### Code Refactoring

* **providers:** provider is pure connection info — drop models + key sync ([a5b623d](https://github.com/namhtpyn/tandem/commit/a5b623d3337fe8f80cd45abfa68d43fbb2fcc8df))


### BREAKING CHANGES

* **providers:** provider is pure connection info — drop models + key sync

## [1.15.1](https://github.com/namhtpyn/tandem/compare/v1.15.0...v1.15.1) (2026-10-11)


### Bug Fixes

* **providers:** secret pickers blank + clearable instead of 'No key' option ([092094d](https://github.com/namhtpyn/tandem/commit/092094d5141407a6ef3c0244d7f6febd257d332d))

# [1.15.0](https://github.com/namhtpyn/tandem/compare/v1.14.1...v1.15.0) (2026-10-11)


### Features

* **projects:** nestable projects + task linkage ([68f4bff](https://github.com/namhtpyn/tandem/commit/68f4bff9c9b9674c5c228cf94b43b034ee46f78f))

## [1.14.1](https://github.com/namhtpyn/tandem/compare/v1.14.0...v1.14.1) (2026-10-11)


### Bug Fixes

* **app:** mobile vertical scroll on dashboard panels + searchable vault pickers ([1f4ba07](https://github.com/namhtpyn/tandem/commit/1f4ba07dc6400c68dceb3668be62bab7688f8121))

# [1.14.0](https://github.com/namhtpyn/tandem/compare/v1.13.3...v1.14.0) (2026-10-11)


### Features

* **providers:** sync models using a vault secret (keySecretId) ([c052869](https://github.com/namhtpyn/tandem/commit/c0528694d42355a521dc57af9cd681ea14ff53cc))

## [1.13.3](https://github.com/namhtpyn/tandem/compare/v1.13.2...v1.13.3) (2026-10-11)


### Bug Fixes

* **providers:** fetchModels follows anthropic pagination (has_more + last_id, cap 10 pages) ([6d3aa3b](https://github.com/namhtpyn/tandem/commit/6d3aa3bb1d5e56aa958caa71c0143694009ab75b))

## [1.13.2](https://github.com/namhtpyn/tandem/compare/v1.13.1...v1.13.2) (2026-10-11)


### Bug Fixes

* **e2e:** provider seed assertions must filter visible (mobile cards + desktop table both render) ([da63694](https://github.com/namhtpyn/tandem/commit/da63694f78a5e929743c12bb93daec12aca75964))

## [1.13.1](https://github.com/namhtpyn/tandem/compare/v1.13.0...v1.13.1) (2026-10-11)


### Bug Fixes

* **settings:** model providers mobile layout — stacked cards instead of table ([e6942c6](https://github.com/namhtpyn/tandem/commit/e6942c67dda720f164816bded0ae0f265317d1ca))

# [1.13.0](https://github.com/namhtpyn/tandem/compare/v1.12.0...v1.13.0) (2026-10-10)


### Features

* **providers:** model provider registry + models catalog + agent model access ([66dd4fb](https://github.com/namhtpyn/tandem/commit/66dd4fbbdbe166db0784a2025835bd770e3b07cf))

# [1.12.0](https://github.com/namhtpyn/tandem/compare/v1.11.0...v1.12.0) (2026-10-10)


### Features

* **tasks:** M4 — tasks CRUD, assignees (human + AI), live list, /tasks page ([ba7f6d6](https://github.com/namhtpyn/tandem/commit/ba7f6d67c406220a1603c5a7aee26a1ca35021eb))

# [1.11.0](https://github.com/namhtpyn/tandem/compare/v1.10.1...v1.11.0) (2026-10-10)


### Features

* **employees:** email editable on update ([ce7ae6d](https://github.com/namhtpyn/tandem/commit/ce7ae6dc7020bd81b3ada6f174245015f94fe6b4))

## [1.10.1](https://github.com/namhtpyn/tandem/compare/v1.10.0...v1.10.1) (2026-10-10)


### Bug Fixes

* **docker:** install openssh-client in the runtime image ([4699f9e](https://github.com/namhtpyn/tandem/commit/4699f9ef73b3f981fb14254b0cc176413ce400cc))
* **ui:** modal actions in footer slot everywhere + auth method dropdown on environments ([279701a](https://github.com/namhtpyn/tandem/commit/279701a22a777a0cadc6bc64cdc590d0cd843457))

# [1.10.0](https://github.com/namhtpyn/tandem/compare/v1.9.0...v1.10.0) (2026-10-10)


### Features

* **employees:** AI harness selector + executable override ([fbfd92a](https://github.com/namhtpyn/tandem/commit/fbfd92a36e408d5d9d7981fdade5fc7b15503a9a))

# [1.9.0](https://github.com/namhtpyn/tandem/compare/v1.8.1...v1.9.0) (2026-10-10)


### Features

* **settings:** company name setting + form hints (info icon hover popovers) + generic placeholders ([e8880db](https://github.com/namhtpyn/tandem/commit/e8880db1ef40e8e0f57ae6691741af1171d95b88))

## [1.8.1](https://github.com/namhtpyn/tandem/compare/v1.8.0...v1.8.1) (2026-10-10)


### Bug Fixes

* **vault:** match page layout pattern of other pages ([d428c7d](https://github.com/namhtpyn/tandem/commit/d428c7d5a8c7bee28c4448627ae314c9ac962d7a))

# [1.8.0](https://github.com/namhtpyn/tandem/compare/v1.7.0...v1.8.0) (2026-10-10)


### Features

* **environments:** secret usage mode (ssh key vs password) + nav fixes ([fd2fdbc](https://github.com/namhtpyn/tandem/commit/fd2fdbcbe9c8309139ffbacba45e1c12bceef4b0))

# [1.7.0](https://github.com/namhtpyn/tandem/compare/v1.6.0...v1.7.0) (2026-10-10)


### Features

* **environments:** link SSH key from vault for server-side auth ([f7a7b1e](https://github.com/namhtpyn/tandem/commit/f7a7b1e5fdd22374af45fb011d75e524d298897d))

# [1.6.0](https://github.com/namhtpyn/tandem/compare/v1.5.0...v1.6.0) (2026-10-10)


### Features

* **vault:** encrypted secret vault with audit trail ([9084607](https://github.com/namhtpyn/tandem/commit/908460756e7414125a9973ef94239fbc7c4dc1f6))

# [1.5.0](https://github.com/namhtpyn/tandem/compare/v1.4.3...v1.5.0) (2026-10-10)


### Features

* **ui:** mobile-first shell + root routes (no /admin prefix) ([82e8d15](https://github.com/namhtpyn/tandem/commit/82e8d1544098528c2b71628385fb4bc3a8126076))

## [1.4.3](https://github.com/namhtpyn/tandem/compare/v1.4.2...v1.4.3) (2026-10-10)


### Bug Fixes

* **coverage:** drop dead post-delete NOT_FOUND branch in employees.remove ([8ea7dea](https://github.com/namhtpyn/tandem/commit/8ea7deae7991ef0745786ae82b3701236af1e9a1))

## [1.4.2](https://github.com/namhtpyn/tandem/compare/v1.4.1...v1.4.2) (2026-10-10)


### Bug Fixes

* **ui:** delete confirmations + last-admin/self-delete guards + modal/footer/key-callout fixes ([ba2c378](https://github.com/namhtpyn/tandem/commit/ba2c37815230736870c13b15f087c607b1270104))

## [1.4.1](https://github.com/namhtpyn/tandem/compare/v1.4.0...v1.4.1) (2026-10-10)


### Bug Fixes

* **e2e:** row-scoped environments selectors + AI-spec teardown — suites are order-independent ([5ae6031](https://github.com/namhtpyn/tandem/commit/5ae6031a320447fb63a14bda2ed48aa7b180537f))

# [1.4.0](https://github.com/namhtpyn/tandem/compare/v1.3.0...v1.4.0) (2026-10-10)


### Features

* **m3:** employees UI — live org table, editor, AI keys drawer ([389c288](https://github.com/namhtpyn/tandem/commit/389c288ac376deddc6d29b28846f96c029093568))

# [1.3.0](https://github.com/namhtpyn/tandem/compare/v1.2.0...v1.3.0) (2026-10-10)


### Features

* **auth:** end-to-end type inference for the role additionalField ([ea93164](https://github.com/namhtpyn/tandem/commit/ea93164fdf039365aa2f8dab9d160591ffaca82d))

# [1.2.0](https://github.com/namhtpyn/tandem/compare/v1.1.2...v1.2.0) (2026-10-10)


### Features

* **m3:** employees, many-to-many supervision, AI extension, API keys ([b673fe2](https://github.com/namhtpyn/tandem/commit/b673fe2c273bb1c2e99d67e9f4df43d29b9f4283))

## [1.1.2](https://github.com/namhtpyn/tandem/compare/v1.1.1...v1.1.2) (2026-10-10)


### Bug Fixes

* **e2e:** deterministic environments tests — unique row names, scoped selectors, single error node ([233b4fb](https://github.com/namhtpyn/tandem/commit/233b4fb5ad4134f3e48241ee2a524e69a335599a))

## [1.1.1](https://github.com/namhtpyn/tandem/compare/v1.1.0...v1.1.1) (2026-10-10)


### Bug Fixes

* **ssr:** consume only the first configLive snapshot in app shell ([a9480f5](https://github.com/namhtpyn/tandem/commit/a9480f5cab21f7f94a257d0c0b407c8257f471f7))

# [1.1.0](https://github.com/namhtpyn/tandem/compare/v1.0.2...v1.1.0) (2026-10-09)


### Features

* **m2:** environments as oRPC v2 live procedures + realtime admin UI ([59dd0a5](https://github.com/namhtpyn/tandem/commit/59dd0a5ad6fcb207e7b86f694fc2225567f3f9eb))

## [1.0.2](https://github.com/namhtpyn/tandem/compare/v1.0.1...v1.0.2) (2026-10-09)


### Bug Fixes

* **ci:** e2e against the CI postgres service database ([fafe13a](https://github.com/namhtpyn/tandem/commit/fafe13a9828bede8865f0c69995fd8953c77298f))

## [1.0.1](https://github.com/namhtpyn/tandem/compare/v1.0.0...v1.0.1) (2026-10-09)


### Bug Fixes

* **ci:** generate .nuxt types via postinstall before typecheck ([b7211f3](https://github.com/namhtpyn/tandem/commit/b7211f3c4c7d3a303876ca8ea5460b1fe7951554))

# 1.0.0 (2026-10-09)


### Features

* tandem M1 foundation + M6 ship — auth, OIDC, health, tests at 100%, e2e, CI, release, docs ([4964c97](https://github.com/namhtpyn/tandem/commit/4964c97f753d2c6ad1a6ae2470c32ec85bbecfe4))
