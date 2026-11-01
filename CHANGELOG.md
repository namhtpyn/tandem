## [2.62.2](https://github.com/namhtpyn/tandem/compare/v2.62.1...v2.62.2) (2026-11-01)


### Bug Fixes

* **reviews:** failed review turns park the round — settle-failure parks replace the wedging work ladder ([#199](https://github.com/namhtpyn/tandem/issues/199)) ([2e4ba8e](https://github.com/namhtpyn/tandem/commit/2e4ba8e29ae23964334ed9a6edbf32b3c249a104))

## [2.62.1](https://github.com/namhtpyn/tandem/compare/v2.62.0...v2.62.1) (2026-11-01)


### Bug Fixes

* **statuses:** truthful advisory copy — transitions editor relabeled as suggestions ([#179](https://github.com/namhtpyn/tandem/issues/179)) ([7e1bcef](https://github.com/namhtpyn/tandem/commit/7e1bceffb93169940fcdff67d2703805530b0b26))

# [2.62.0](https://github.com/namhtpyn/tandem/compare/v2.61.5...v2.62.0) (2026-11-01)


### Features

* **environments:** probe verdict persists on the row — Status survives reload, updates invalidate on connection change, probes run independently ([#178](https://github.com/namhtpyn/tandem/issues/178)) ([2e9c20e](https://github.com/namhtpyn/tandem/commit/2e9c20eda2deb4e236c42d1c145a008f5545e972))

## [2.61.5](https://github.com/namhtpyn/tandem/compare/v2.61.4...v2.61.5) (2026-11-01)


### Bug Fixes

* **tasks:** abandon lands in work states + submit keys off the working category — verbs render only where the server accepts ([#177](https://github.com/namhtpyn/tandem/issues/177)) ([323b651](https://github.com/namhtpyn/tandem/commit/323b6516687523c2026d2eb85fe4972028777d83))

## [2.61.4](https://github.com/namhtpyn/tandem/compare/v2.61.3...v2.61.4) (2026-11-01)


### Bug Fixes

* **perf:** dispatcher eligible scan bounded — backoff predicate + LIMIT pushed into SQL ([#176](https://github.com/namhtpyn/tandem/issues/176)) ([bd18ed9](https://github.com/namhtpyn/tandem/commit/bd18ed930de70215c56ba568af63ab7e8aa381fa))

## [2.61.3](https://github.com/namhtpyn/tandem/compare/v2.61.2...v2.61.3) (2026-11-01)


### Bug Fixes

* **api:** titles catalog save wired at admin tier — cascade rename is an admin write ([#174](https://github.com/namhtpyn/tandem/issues/174)) ([83fc6b4](https://github.com/namhtpyn/tandem/commit/83fc6b46531e667bc58e1ef6fabb93ce778b42c8))

## [2.61.2](https://github.com/namhtpyn/tandem/compare/v2.61.1...v2.61.2) (2026-11-01)


### Bug Fixes

* **perf:** bounded thread hot path — newest-page cap + on-demand threadOlderPage proc, task-scoped outputs scan (dead IS NULL arm dropped), runs snapshot cap ([#175](https://github.com/namhtpyn/tandem/issues/175)) ([26db6f5](https://github.com/namhtpyn/tandem/commit/26db6f572aad7f80677746a4e3977b246f34b5d2))

## [2.61.1](https://github.com/namhtpyn/tandem/compare/v2.61.0...v2.61.1) (2026-11-01)


### Bug Fixes

* **api:** attachment upload wired at write tier — role gate, pre-parse body cap, per-task input quota ([#173](https://github.com/namhtpyn/tandem/issues/173)) ([ea0b513](https://github.com/namhtpyn/tandem/commit/ea0b513cbd53a3a9b1d1828b94f98ef8ef155573))

# [2.61.0](https://github.com/namhtpyn/tandem/compare/v2.60.13...v2.61.0) (2026-11-01)


### Features

* **auth:** no default admin credential — boot seed requires ADMIN_PASSWORD, seeded admin rotates on first login ([#172](https://github.com/namhtpyn/tandem/issues/172)) ([d626a5b](https://github.com/namhtpyn/tandem/commit/d626a5b3826bcd5a57ce85f3c458fe47973c5a8b))

## [2.60.13](https://github.com/namhtpyn/tandem/compare/v2.60.12...v2.60.13) (2026-11-01)


### Bug Fixes

* **dispatcher:** TICK-ISOLATION — scanOnce catches every leg incl. the find-eligible DB reads; a failed tick can no longer crash the process ([#180](https://github.com/namhtpyn/tandem/issues/180)) ([146760c](https://github.com/namhtpyn/tandem/commit/146760cf9fc96f3e928c121e42254138306bc4eb))

## [2.60.12](https://github.com/namhtpyn/tandem/compare/v2.60.11...v2.60.12) (2026-11-01)


### Bug Fixes

* **tasks:** newest-run-of-task is ONE shared bounded findFirst — reaper stops fetch-alling + JS-sorting runs ([#163](https://github.com/namhtpyn/tandem/issues/163)) ([3753425](https://github.com/namhtpyn/tandem/commit/37534259334b4f07a9ff395571974042c7d85da3))

## [2.60.11](https://github.com/namhtpyn/tandem/compare/v2.60.10...v2.60.11) (2026-11-01)


### Bug Fixes

* **tasks:** liveSteers entry deleted when the run settles — one ACP client context retained per finished run forever ([#161](https://github.com/namhtpyn/tandem/issues/161)) ([f494d1b](https://github.com/namhtpyn/tandem/commit/f494d1bed8de1338401887a5f3ef1f6a9eb38eaf))

## [2.60.10](https://github.com/namhtpyn/tandem/compare/v2.60.9...v2.60.10) (2026-11-01)


### Bug Fixes

* **tasks:** dispatch claim is a conditional flip — losers abort pre-insert, guard-rejected RUNNING rows settle ([#162](https://github.com/namhtpyn/tandem/issues/162)) ([d58f229](https://github.com/namhtpyn/tandem/commit/d58f22974fe20bd51e6827c948ef1e34f81922a7))

## [2.60.9](https://github.com/namhtpyn/tandem/compare/v2.60.8...v2.60.9) (2026-11-01)


### Bug Fixes

* **tasks:** sweep sandbox staging after EVERY settle (success included, self-excluded sibling check) and never re-store a byte-identical output ([#160](https://github.com/namhtpyn/tandem/issues/160)) ([53a8a8f](https://github.com/namhtpyn/tandem/commit/53a8a8f46c07cbf2def25e7c33e8d28bfc4e6c22))

## [2.60.8](https://github.com/namhtpyn/tandem/compare/v2.60.7...v2.60.8) (2026-11-01)


### Bug Fixes

* **spec:** contract-reality alignment - single ACP v1 runner contract, required redis, shipped M3, exact REST exception set ([#149](https://github.com/namhtpyn/tandem/issues/149)) ([abd131c](https://github.com/namhtpyn/tandem/commit/abd131c214ed080d9eeeda369fb7e889bb67dd89))

## [2.60.7](https://github.com/namhtpyn/tandem/compare/v2.60.6...v2.60.7) (2026-11-01)


### Bug Fixes

* **tasks:** task removal sweeps the stored attachment bytes — BYTES-WITH-TASK ([#150](https://github.com/namhtpyn/tandem/issues/150)) ([db02572](https://github.com/namhtpyn/tandem/commit/db0257234f1b0f5497dee813bcf6816f91f38ca3))

## [2.60.6](https://github.com/namhtpyn/tandem/compare/v2.60.5...v2.60.6) (2026-11-01)


### Bug Fixes

* **dispatcher:** reaper liveness — rate-limited warn on failed sweeps, boot dispatcher start retries until the queue is reachable ([#147](https://github.com/namhtpyn/tandem/issues/147)) ([0da20b6](https://github.com/namhtpyn/tandem/commit/0da20b684c96deb8ffea5b7e1d6856113c8f8d30))

## [2.60.5](https://github.com/namhtpyn/tandem/compare/v2.60.4...v2.60.5) (2026-11-01)


### Bug Fixes

* **tasks:** editor save with an unresolved/failed description prefetch no longer wipes the stored body ([#145](https://github.com/namhtpyn/tandem/issues/145)) ([#146](https://github.com/namhtpyn/tandem/issues/146)) ([4391271](https://github.com/namhtpyn/tandem/commit/43912714c5524e4cad0d016525f7a8fbd3e94ca1))

## [2.60.4](https://github.com/namhtpyn/tandem/compare/v2.60.3...v2.60.4) (2026-11-01)


### Performance Improvements

* **tasks:** bound list-time obligation reads + take description off the wire ([#130](https://github.com/namhtpyn/tandem/issues/130) slice 3) ([#143](https://github.com/namhtpyn/tandem/issues/143)) ([ac8b3da](https://github.com/namhtpyn/tandem/commit/ac8b3da4081b767af6e78be82a7f99698b067e29))

## [2.60.3](https://github.com/namhtpyn/tandem/compare/v2.60.2...v2.60.3) (2026-11-01)


### Performance Improvements

* **tasks:** transcripts on demand — snapshots carry live output only, tasks.runTranscript serves settled text ([#141](https://github.com/namhtpyn/tandem/issues/141)) ([2d952c1](https://github.com/namhtpyn/tandem/commit/2d952c1379811967e84efa1b677e7bb0a48652ca)), closes [#130](https://github.com/namhtpyn/tandem/issues/130) [#130](https://github.com/namhtpyn/tandem/issues/130)

## [2.60.2](https://github.com/namhtpyn/tandem/compare/v2.60.1...v2.60.2) (2026-10-31)


### Performance Improvements

* **dispatch:** bound the 5s tick — scan WHERE pushdown, one GROUP BY cap count, transcript-free reaper + hot-path indexes ([#130](https://github.com/namhtpyn/tandem/issues/130)) ([#139](https://github.com/namhtpyn/tandem/issues/139)) ([6ecf131](https://github.com/namhtpyn/tandem/commit/6ecf131f028ba046660c83687c648ebc3c4d8923))

## [2.60.1](https://github.com/namhtpyn/tandem/compare/v2.60.0...v2.60.1) (2026-10-31)


### Bug Fixes

* **e2e:** poll the awaiting=1 URL sync instead of a single assert (flaked the v2.60.0 release train twice) ([#137](https://github.com/namhtpyn/tandem/issues/137)) ([1d6a161](https://github.com/namhtpyn/tandem/commit/1d6a161050547a08edeee3a3e845c2b78ff871a1))

# [2.60.0](https://github.com/namhtpyn/tandem/compare/v2.59.2...v2.60.0) (2026-10-31)


### Features

* **security:** SSH transports verify the host key — TOFU store, mismatch fails closed ([#129](https://github.com/namhtpyn/tandem/issues/129)) ([#135](https://github.com/namhtpyn/tandem/issues/135)) ([8ddc19a](https://github.com/namhtpyn/tandem/commit/8ddc19a71a35500158137fd88ead55ce9d035f9f))

## [2.59.2](https://github.com/namhtpyn/tandem/compare/v2.59.1...v2.59.2) (2026-10-31)


### Bug Fixes

* **auth:** OIDC linking requires a verified IdP email claim — closes admin takeover path ([#127](https://github.com/namhtpyn/tandem/issues/127)) ([#131](https://github.com/namhtpyn/tandem/issues/131)) ([f5d398b](https://github.com/namhtpyn/tandem/commit/f5d398b770449f651463695518c13423e8f33408))
* **authz:** verdict procedures are human-only — API-key sessions rejected server-side ([#128](https://github.com/namhtpyn/tandem/issues/128)) ([#133](https://github.com/namhtpyn/tandem/issues/133)) ([a0e8c5f](https://github.com/namhtpyn/tandem/commit/a0e8c5fbb383ac6fc3cf14eb6a575b64b23e9396))

## [2.59.1](https://github.com/namhtpyn/tandem/compare/v2.59.0...v2.59.1) (2026-10-31)


### Bug Fixes

* **auth:** OIDC linking requires a verified IdP email claim — closes admin takeover path ([#127](https://github.com/namhtpyn/tandem/issues/127)) ([#131](https://github.com/namhtpyn/tandem/issues/131)) ([#132](https://github.com/namhtpyn/tandem/issues/132)) ([901d5a1](https://github.com/namhtpyn/tandem/commit/901d5a19a2cf58b7839e04daff06347bb2d2627c))

# [2.59.0](https://github.com/namhtpyn/tandem/compare/v2.58.0...v2.59.0) (2026-10-31)


### Features

* **health:** live settings-corruption detector — corrupt known keys degrade readiness ([#123](https://github.com/namhtpyn/tandem/issues/123)) ([85886f3](https://github.com/namhtpyn/tandem/commit/85886f39e980386e01d41d1c23c73ed12020fb44)), closes [#113](https://github.com/namhtpyn/tandem/issues/113)

# [2.58.0](https://github.com/namhtpyn/tandem/compare/v2.57.0...v2.58.0) (2026-10-31)


### Features

* **ops:** game-day restore drill — inject/detect/heal with TEST-stack guards ([#113](https://github.com/namhtpyn/tandem/issues/113)) ([#122](https://github.com/namhtpyn/tandem/issues/122)) ([1b9210f](https://github.com/namhtpyn/tandem/commit/1b9210fd062543e068f985aa9eb3187c9163f634))

# [2.57.0](https://github.com/namhtpyn/tandem/compare/v2.56.5...v2.57.0) (2026-10-31)


### Features

* **settings:** settings-backed feature flags — off-state default, tasks.turn-durations ([#111](https://github.com/namhtpyn/tandem/issues/111)) ([#120](https://github.com/namhtpyn/tandem/issues/120)) ([3a98d2b](https://github.com/namhtpyn/tandem/commit/3a98d2bcca19908bf397ecf4aaf856c137dfd146))

## [2.56.5](https://github.com/namhtpyn/tandem/compare/v2.56.4...v2.56.5) (2026-10-31)


### Bug Fixes

* **supply-chain:** pin actions by SHA, least-privilege workflow permissions, digest-pinned bases, CI gate ([#112](https://github.com/namhtpyn/tandem/issues/112)) ([#118](https://github.com/namhtpyn/tandem/issues/118)) ([fedd647](https://github.com/namhtpyn/tandem/commit/fedd647df16670611ac5410841e48247523a102e))

## [2.56.4](https://github.com/namhtpyn/tandem/compare/v2.56.3...v2.56.4) (2026-10-31)


### Bug Fixes

* **release:** releaseRules must use the long {type, release} form ([990c861](https://github.com/namhtpyn/tandem/commit/990c8614a82636318989a691a0c2a78d550f38d3)), closes [#107](https://github.com/namhtpyn/tandem/issues/107) [#108](https://github.com/namhtpyn/tandem/issues/108)
* **release:** treat revert commits as patch releases ([beb206b](https://github.com/namhtpyn/tandem/commit/beb206bf311d0a8893bd4217ee47bc2bbe697f07))
* **tasks:** scrollable control rows carry a right-edge affordance and 44px phone targets ([#106](https://github.com/namhtpyn/tandem/issues/106)) ([#103](https://github.com/namhtpyn/tandem/issues/103)) ([b94a398](https://github.com/namhtpyn/tandem/commit/b94a39881aeb1e75ca16b2791b1eef6f4af5e611))


### Reverts

* **dispatch:** remove peak/off-peak cadence — agents run full speed 24/7 ([a0209e0](https://github.com/namhtpyn/tandem/commit/a0209e072274fd3c7ed507789528684dbf269498)), closes [#70](https://github.com/namhtpyn/tandem/issues/70)

## [2.56.3](https://github.com/namhtpyn/tandem/compare/v2.56.2...v2.56.3) (2026-10-31)


### Bug Fixes

* **tasks:** view toggle pinned outside the toolbar action scroller ([#99](https://github.com/namhtpyn/tandem/issues/99)) ([#101](https://github.com/namhtpyn/tandem/issues/101)) ([ed14c4c](https://github.com/namhtpyn/tandem/commit/ed14c4c8763a29ab64f945533ea53497fc10bdf6)), closes [#96](https://github.com/namhtpyn/tandem/issues/96)

## [2.56.2](https://github.com/namhtpyn/tandem/compare/v2.56.1...v2.56.2) (2026-10-31)


### Bug Fixes

* **tasks:** mobile card kebab carries the Workflow drawer entry ([#96](https://github.com/namhtpyn/tandem/issues/96)) ([#98](https://github.com/namhtpyn/tandem/issues/98)) ([d88f00c](https://github.com/namhtpyn/tandem/commit/d88f00cba27ae7ae10eb26ce6897277a02294d95))

## [2.56.1](https://github.com/namhtpyn/tandem/compare/v2.56.0...v2.56.1) (2026-10-31)


### Bug Fixes

* **tasks:** forward verb renders only where the server accepts it ([#92](https://github.com/namhtpyn/tandem/issues/92)) ([#95](https://github.com/namhtpyn/tandem/issues/95)) ([8abce91](https://github.com/namhtpyn/tandem/commit/8abce9141ac346681b800555ff2d6c64564f1d86))

# [2.56.0](https://github.com/namhtpyn/tandem/compare/v2.55.2...v2.56.0) (2026-10-31)


### Features

* **tasks:** awaiting-decision company queue — chip with live count, row badges, overview card ([#91](https://github.com/namhtpyn/tandem/issues/91)) ([f57d3fd](https://github.com/namhtpyn/tandem/commit/f57d3fd731d14cc715493248a03d2622886e5066))
* **tasks:** awaitingDecision company-wide filter on tasks.listPaged ([#91](https://github.com/namhtpyn/tandem/issues/91)) ([276cf2a](https://github.com/namhtpyn/tandem/commit/276cf2a9880538b56f26a7cc873321b060d8a4fa))

## [2.55.2](https://github.com/namhtpyn/tandem/compare/v2.55.1...v2.55.2) (2026-10-31)


### Bug Fixes

* **dispatch:** liveness sweep + unblock restore resolution — working statuses are run-backed ([#88](https://github.com/namhtpyn/tandem/issues/88)) ([#89](https://github.com/namhtpyn/tandem/issues/89)) ([3f33e4e](https://github.com/namhtpyn/tandem/commit/3f33e4eb7996be3e1e365e6987fa934c2cb6f8cd))

## [2.55.1](https://github.com/namhtpyn/tandem/compare/v2.55.0...v2.55.1) (2026-10-31)


### Bug Fixes

* **auth:** server-side RBAC — role-gate every write procedure ([#82](https://github.com/namhtpyn/tandem/issues/82)) ([2f9483d](https://github.com/namhtpyn/tandem/commit/2f9483d33b468db42292e794a9c5a4217d54cc1c))

# [2.55.0](https://github.com/namhtpyn/tandem/compare/v2.54.0...v2.55.0) (2026-10-31)


### Features

* **dispatch:** peak-window cadence — effective per-agent cap ([#70](https://github.com/namhtpyn/tandem/issues/70)) ([1d26251](https://github.com/namhtpyn/tandem/commit/1d262519348a6a212da6d8c364330df8cf909aba))

# [2.54.0](https://github.com/namhtpyn/tandem/compare/v2.53.0...v2.54.0) (2026-10-31)


### Features

* **tasks:** inline input images as ACP prompt image blocks ([fc37716](https://github.com/namhtpyn/tandem/commit/fc37716cfa61340b25b4431a2290c14aff1b6253))

# [2.53.0](https://github.com/namhtpyn/tandem/compare/v2.52.3...v2.53.0) (2026-10-31)


### Features

* **tasks:** attach collected screenshots to the run result message ([a6d96e9](https://github.com/namhtpyn/tandem/commit/a6d96e9cfc9fa0d8afe8db774bcc93fc4b0b505c)), closes [#69](https://github.com/namhtpyn/tandem/issues/69)

## [2.52.3](https://github.com/namhtpyn/tandem/compare/v2.52.2...v2.52.3) (2026-10-30)


### Bug Fixes

* **tasks:** pin the review-round result body — regression net for the task_activity drop ([a30707f](https://github.com/namhtpyn/tandem/commit/a30707f478cffff54e97604416723252aaecd629))

## [2.52.2](https://github.com/namhtpyn/tandem/compare/v2.52.1...v2.52.2) (2026-10-30)


### Bug Fixes

* **tasks:** setStatus resolves the target against seeded status ids ([a221cfd](https://github.com/namhtpyn/tandem/commit/a221cfdff3a7d75c10a2254019e983ba8c3f31b1)), closes [#62](https://github.com/namhtpyn/tandem/issues/62)

## [2.52.1](https://github.com/namhtpyn/tandem/compare/v2.52.0...v2.52.1) (2026-10-30)


### Bug Fixes

* **acp:** cancel gateway-resident turns on failure and on resume ([5503c17](https://github.com/namhtpyn/tandem/commit/5503c179a0ca3d8729e627006bc86c0e4d878faf))
* **dispatch:** enforce the per-agent cap at claim time ([1ecefa1](https://github.com/namhtpyn/tandem/commit/1ecefa1af8a7f8fd4e17bfaa19c99557d89fc628))

# [2.52.0](https://github.com/namhtpyn/tandem/compare/v2.51.1...v2.52.0) (2026-10-29)


### Features

* **review:** humans cannot submit an escalate review (AI-only verb) ([66db1ee](https://github.com/namhtpyn/tandem/commit/66db1ee0d92f88772afe57e87ef6ba2ec065d047))

## [2.51.1](https://github.com/namhtpyn/tandem/compare/v2.51.0...v2.51.1) (2026-10-29)


### Bug Fixes

* **review:** one Ash item per review turn — verdict rides the run bubble ([c0273e9](https://github.com/namhtpyn/tandem/commit/c0273e9f0e741af69bebbf1d6566b02e8a1b0797))
* **steering:** the live-run lookup reads the runs table — the composer law works again ([6115976](https://github.com/namhtpyn/tandem/commit/61159765bd22bc7adc91aebcf9f43fb440d0c737))

# [2.51.0](https://github.com/namhtpyn/tandem/compare/v2.50.1...v2.51.0) (2026-10-29)


### Features

* **review:** sequential rounds, verdict-identity envelope, escalation, blocked parks ([c930258](https://github.com/namhtpyn/tandem/commit/c9302582869f12ddb72a6b8e29f8dd210f10db79))

## [2.50.1](https://github.com/namhtpyn/tandem/compare/v2.50.0...v2.50.1) (2026-10-29)


### Bug Fixes

* **brief:** relay keys on a resumable session; deliverables fold into the output contract ([ea983f8](https://github.com/namhtpyn/tandem/commit/ea983f81fd4ae20f06b3214dcf2dfc33f553c6f4))
* **runner:** verdicts always land — parser recovery, one Jay response, review re-dispatch ([586934a](https://github.com/namhtpyn/tandem/commit/586934afe13a0d54adc1319ef1007b52f73944d0))

# [2.50.0](https://github.com/namhtpyn/tandem/compare/v2.49.2...v2.50.0) (2026-10-29)


### Features

* **dispatch:** run-level retries — the run is the unit of work ([f145d32](https://github.com/namhtpyn/tandem/commit/f145d32a5647a5f673a08f31bfb5795ff4a1a70b))

## [2.49.2](https://github.com/namhtpyn/tandem/compare/v2.49.1...v2.49.2) (2026-10-28)


### Bug Fixes

* **app:** prod-build oRPC import inlines; dev keeps the opaque specifier ([41d4f6b](https://github.com/namhtpyn/tandem/commit/41d4f6b4b822ba47170a3e4ce0f0a602eeb3d1a8))

## [2.49.1](https://github.com/namhtpyn/tandem/compare/v2.49.0...v2.49.1) (2026-10-28)


### Bug Fixes

* **ci:** keep component coverage out of the global v8 gate ([6fbe95d](https://github.com/namhtpyn/tandem/commit/6fbe95d5b89d7edb7145e821462ae11ecc92cb09))
* **ci:** restore the nuxt project's explicit coverage opt-out ([03b1ff8](https://github.com/namhtpyn/tandem/commit/03b1ff89740de4e5644b5e99dc8fa0c91149e041))
* **dev:** orpc plugin's SSR dynamic imports use variable specifiers ([486f0e1](https://github.com/namhtpyn/tandem/commit/486f0e1ff92dcab3f21d293c8783b76b24b0d86f))
* **e2e:** global-setup applies drizzle migrations itself ([e8398aa](https://github.com/namhtpyn/tandem/commit/e8398aadd2653c650ca360564ab1a70fc5aaac95))
* **e2e:** one migrator — server owns boot migration, hook waits ([01c0f57](https://github.com/namhtpyn/tandem/commit/01c0f5766b1e779f8bfc0ce1c76b3dc623cb7ca7))
* **package:** update scripts to use bun and upgrade dependencies ([e312e3a](https://github.com/namhtpyn/tandem/commit/e312e3a52ad4d50dbfbc8dcc820ab5ec87ed1888))
* **server:** audit round 8a — transactions, ordering, publishes ([8b1e216](https://github.com/namhtpyn/tandem/commit/8b1e2161d7c2d709fcc9c0b18a1ec9185e5133da))
* **ui:** audit round 4 — consistency batch (component law, copy, a11y) ([612025c](https://github.com/namhtpyn/tandem/commit/612025cc712d423fb3cabe0b99f326c3bbae97fe)), closes [#label-cell](https://github.com/namhtpyn/tandem/issues/label-cell)
* **ui:** audit round 5 — consistency, sanitize, component law ([1da94b8](https://github.com/namhtpyn/tandem/commit/1da94b869e1e51e56209bbad13b67ad0db289944))
* **ui:** audit round 6 — state edges, a11y, sanitize, test hygiene ([f45b5af](https://github.com/namhtpyn/tandem/commit/f45b5af3eb89860656694a96628d320e0b0a02a0)), closes [#shared](https://github.com/namhtpyn/tandem/issues/shared) [#hint](https://github.com/namhtpyn/tandem/issues/hint)
* **ui:** audit round 7a — theme, shell, managers, tests ([376c52b](https://github.com/namhtpyn/tandem/commit/376c52bdf000a6a0385a8bd1a53228ede8f2d49b))
* **ui:** audit round 7b — tasks domain, a11y, test infra ([862735d](https://github.com/namhtpyn/tandem/commit/862735d57d0fa43716a365cd73d58848ad8bbc43))
* **ui:** audit round 8b/c — tokens, gutters, tasks, managers, a11y, copy ([c378624](https://github.com/namhtpyn/tandem/commit/c378624ca4fe5f3733f27f634c308180ff9adc85))
* **ui:** audit-loop round 2 — blind visual + code findings ([5f75653](https://github.com/namhtpyn/tandem/commit/5f75653062b448089fe5db777aa4b6b435be3510))
* **ui:** audit-loop round 3 — code-audit findings ([45aa5ed](https://github.com/namhtpyn/tandem/commit/45aa5ed99cf46e9f639965a5baacc5d397f26bde))
* **ui:** audit-loop round 3 — dead slot, board polish, overview pluralization ([7a1d6ea](https://github.com/namhtpyn/tandem/commit/7a1d6ea265bb205fe7a58d95f49f6c91065b930d)), closes [#assignee-cell](https://github.com/namhtpyn/tandem/issues/assignee-cell)
* **ui:** board status legibility — distinct category glyphs + waiting_answer color ([e7be39d](https://github.com/namhtpyn/tandem/commit/e7be39d956bfd397e7c9221e57c031aede379bef))
* **ui:** frontend audit remediation — all 85 findings ([8958cae](https://github.com/namhtpyn/tandem/commit/8958cae163047be8f5086360b07e77a51a963dc7)), closes [#body](https://github.com/namhtpyn/tandem/issues/body)
* **ui:** visual pass 9 — gutter parity, one CTA per empty list, board scroll cue, calmer settings saves ([a5082a3](https://github.com/namhtpyn/tandem/commit/a5082a38cd382d9de5be6758c9e30ac6ee4a69ac))
* **ui:** visual-audit remediation round 1 + docs ([856222d](https://github.com/namhtpyn/tandem/commit/856222d2e975cc54bb1a56686db710ac5800702f)), closes [#empty-cta](https://github.com/namhtpyn/tandem/issues/empty-cta)

# [2.49.0](https://github.com/namhtpyn/tandem/compare/v2.48.0...v2.49.0) (2026-10-27)


### Bug Fixes

* envelope stream corruption, prompt echo leak, status edges ([527cede](https://github.com/namhtpyn/tandem/commit/527cede1a8ae0f776595b5869ef5dcb6394d5daa))
* **queue:** bounded redis reconnect; serial test asserts execution windows ([cf20061](https://github.com/namhtpyn/tandem/commit/cf200612c29563407d8c286a2b86254acde0bd8b))
* **thread:** echo dedupe ms-precision, run-turn avatar, cap-leak test ([145f192](https://github.com/namhtpyn/tandem/commit/145f192c5a3c13172e198cc1c77b6eabb82ca415))


### Features

* **composer:** send steers a live agent, dispatches a stopped one; single button ([bae8efe](https://github.com/namhtpyn/tandem/commit/bae8efefb275aced6934d414c13af4dd8bbdab9f))
* **tasks:** manual status is free; live runs lock status + assignee; Workflow block removed ([56239b0](https://github.com/namhtpyn/tandem/commit/56239b003ef9052862b86bb5a441bc4e9de94c9a))
* **tasks:** subtasks open the create modal; owner field out; reviewers multi-select ([8fc2429](https://github.com/namhtpyn/tandem/commit/8fc24294b54e3a0adb04fc7d17d1598eecbb716c)), closes [#body](https://github.com/namhtpyn/tandem/issues/body)

# [2.48.0](https://github.com/namhtpyn/tandem/compare/v2.47.1...v2.48.0) (2026-10-27)


### Bug Fixes

* **thread:** run turns render as chat bubbles; echo notes deduped ([54b19ba](https://github.com/namhtpyn/tandem/commit/54b19ba6d314a41932baa4549d68cf2f0779bf77))


### Features

* **brief:** multi-supervisor chains — one level per layer, joined by & ([9ee443d](https://github.com/namhtpyn/tandem/commit/9ee443d0afc00dc6ceaadd003bd290c5712eb7b5))

## [2.47.1](https://github.com/namhtpyn/tandem/compare/v2.47.0...v2.47.1) (2026-10-27)


### Bug Fixes

* **db:** prod-proof the obligations FK rename — pre-squash constraint name ([dff6627](https://github.com/namhtpyn/tandem/commit/dff6627a01441d287199f7ac64e25c189bdd34ea))

# [2.47.0](https://github.com/namhtpyn/tandem/compare/v2.46.0...v2.47.0) (2026-10-27)


### Bug Fixes

* 10-reviewer audit sweep — reliability, state machine, data safety, UI, infra, docs ([93c7bad](https://github.com/namhtpyn/tandem/commit/93c7baddfca6e6c4f2ebaf8771dc2c96908d3b96))
* **ci:** pin oxfmt 0.75 — bunx@latest reformats drift between runs ([2101d46](https://github.com/namhtpyn/tandem/commit/2101d464ecaa624d9870ddde3d90d4f6ca5ef87f))
* **ci:** pin oxlint 1.89 as devDep — TS config imports the package now ([0c9709b](https://github.com/namhtpyn/tandem/commit/0c9709bc510e09ba5ab45cfb109e10bd8432147a))
* low-tier sweep — hydration-safe timestamps, session-lookup index, a11y, live proposals ([de03514](https://github.com/namhtpyn/tandem/commit/de035144133700f740ac1f2308f2fa1d5912f368))


### Features

* **app:** GitHub-style review box, auto-answer composer, no human Ask ([2f2c870](https://github.com/namhtpyn/tandem/commit/2f2c870e55658e4c667d5dbfcc08b509882b3cfd))

# [2.46.0](https://github.com/namhtpyn/tandem/compare/v2.45.0...v2.46.0) (2026-10-26)


### Bug Fixes

* **docker:** bump base image to bun 1.4.4 (CVE-2026-111497 brotli OOB write) ([98872a3](https://github.com/namhtpyn/tandem/commit/98872a3c7165e1af9c583d5ffdb3f01dba696d33))


### Features

* **app:** composer posts plain notes; workflow verbs render per state ([07b8181](https://github.com/namhtpyn/tandem/commit/07b81817673dffebf2311a493c63b309ae465df7))
* **brief:** activity section = thread messages after the last finished run ([bbfab4c](https://github.com/namhtpyn/tandem/commit/bbfab4ca3b8faf6bbc22b847887678c69ad7222a))
* **brief:** prompt is a conversation relay, not a re-brief ([be2fa25](https://github.com/namhtpyn/tandem/commit/be2fa25d7e3894228bd2d9e65465907e7a96de53))
* **brief:** prompt message lines ship whole — no truncation ([4e81b5f](https://github.com/namhtpyn/tandem/commit/4e81b5f24b091222fa79a43d224e14974b9caa61))
* **routing:** fold SUBTASKS/REASSIGN into the JSON envelope ([1106087](https://github.com/namhtpyn/tandem/commit/11060877fdb580f2300f9fc696f2ff5bf6e9d3cd))

# [2.45.0](https://github.com/namhtpyn/tandem/compare/v2.44.1...v2.45.0) (2026-10-26)


### Features

* **app:** run turn shows the message body with expandable raw input + output ([edf8c14](https://github.com/namhtpyn/tandem/commit/edf8c14f3a86d35ac17f20eb309a4d74c1a4aac9))
* **workflow:** explicit reviewers only — supervisor is not a quality gate ([bbe889e](https://github.com/namhtpyn/tandem/commit/bbe889e466ba6d2057451cf13b2813086d10f007))

## [2.44.1](https://github.com/namhtpyn/tandem/compare/v2.44.0...v2.44.1) (2026-10-26)


### Bug Fixes

* **db:** drop legacy task_runs.task_id on upgraded DBs ([c9f7afa](https://github.com/namhtpyn/tandem/commit/c9f7afa541f77ae5d9204166beaf1b61862ec9fd))

# [2.44.0](https://github.com/namhtpyn/tandem/compare/v2.43.0...v2.44.0) (2026-10-26)


### Features

* **app:** thread shows raw run output, drops input fold and STATUS chatter ([a004bf5](https://github.com/namhtpyn/tandem/commit/a004bf59376fd1220566be0b679c4da14eab61a3))
* **run:** runs link tasks via thread messages (user design, 2026-10-26) ([7ac32bb](https://github.com/namhtpyn/tandem/commit/7ac32bbc8a1c8d7acc6efdf9e4c2efa696b3269b))

# [2.43.0](https://github.com/namhtpyn/tandem/compare/v2.42.0...v2.43.0) (2026-10-26)


### Bug Fixes

* **app:** task sidebar status picker routes through tasks.setStatus ([b8199a0](https://github.com/namhtpyn/tandem/commit/b8199a0263428b62b314f79ae1de3860f7402370))
* **db:** thread backfill payload carries the activity kind ([6dcc407](https://github.com/namhtpyn/tandem/commit/6dcc40735c0093f932cca6608cf85bd9d7cc0956))
* **security:** close run-1 audit findings — role gates, secret-egress binding, exec escaping, workflow integrity ([d321913](https://github.com/namhtpyn/tandem/commit/d3219138827b7c680e2522769669cecac07dc216))


### Features

* **db:** task conversation tables — base thread + per-kind extensions (phase 1) ([7a9d4d7](https://github.com/namhtpyn/tandem/commit/7a9d4d7d9ea8b927ee5c2229a882644f01ec726e))
* **tasks:** unified conversation thread — thread procs + dual-write + client swap (phases 2-3) ([67fb645](https://github.com/namhtpyn/tandem/commit/67fb645112607629d3258a4aa20fdb0efbba5394))


### Reverts

* **security:** drop role/permission gates — not needed yet (owner order) ([4048e60](https://github.com/namhtpyn/tandem/commit/4048e60794816a0d92fd8355734ab35df16fb442))

# [2.42.0](https://github.com/namhtpyn/tandem/compare/v2.41.0...v2.42.0) (2026-10-24)


### Bug Fixes

* **app:** drop the non-null assertion in the picker fallback ([80ef966](https://github.com/namhtpyn/tandem/commit/80ef9667ab133ed175b3aa286050029ddc11fec7))
* **app:** every page stopped scrolling — cap UDashboardPanel inside the fixed shell ([1faa0de](https://github.com/namhtpyn/tandem/commit/1faa0ded8095b911380f36bbab30f68ee7f985cb))
* **app:** folder picker — ignore-filter is the actual off switch for client filtering ([26653c1](https://github.com/namhtpyn/tandem/commit/26653c1b4abcaf0ea769d12562478954079521fa))
* **app:** folder picker loaded 2 pages per scroll — flip a sync guard in the handler ([35d78cd](https://github.com/namhtpyn/tandem/commit/35d78cdd36b9c2a351bac882b356285205abfbc9))
* **app:** folder picker page size 50 -> 20 — first page should look like a page ([fd68540](https://github.com/namhtpyn/tandem/commit/fd685404b15e6ecc9a7b9ff78d2eb2d2236efb41))
* **app:** kill the remaining direct $fetch RPC calls on the tasks pages ([5372c28](https://github.com/namhtpyn/tandem/commit/5372c2815f58e970d1d60c29d252e6da077ffaad))
* **app:** pagination footer lives in DataTable — folders manager gets working pages ([80a7b1b](https://github.com/namhtpyn/tandem/commit/80a7b1b8bcdb8f262c413c3eb4f186d6859cb7e3))
* **app:** restore documented dashboard layout instead of overriding the theme ([6c336db](https://github.com/namhtpyn/tandem/commit/6c336dbc037d9ca180738e5a9bc44efa0e4be7af))
* **app:** secret modal folder select uses size=md to match the form inputs ([216465c](https://github.com/namhtpyn/tandem/commit/216465cbd398783e5e6708aab28d068f9f179793))
* **app:** vault QA round — perf + picker label + destructive-action spacing ([54bf453](https://github.com/namhtpyn/tandem/commit/54bf453ca606d746ff039b59bee9fa878c371022))
* **app:** VaultFolderSelect loads pages through vue-query over the oRPC client ([a3921a2](https://github.com/namhtpyn/tandem/commit/a3921a21b4a4f0e291668842e83b7f2f3d2ef214))


### Features

* **app:** capability flags on the vault folder components ([eb4aa6a](https://github.com/namhtpyn/tandem/commit/eb4aa6af7e50a660f657b040e522e6accb8778ca))
* **app:** folder picker search filters on the server ([f7cf21a](https://github.com/namhtpyn/tandem/commit/f7cf21a01b5a6e455c77464afda170d84c12daac))
* **app:** FolderSelect — self-loading vault folder picker component ([e961949](https://github.com/namhtpyn/tandem/commit/e96194983b9fcc401bcb05902c0c31de76c8925a))
* **app:** reload prompt when a newer build is deployed ([dcc3d50](https://github.com/namhtpyn/tandem/commit/dcc3d50044b831a8f53e6bd3e2cb2da2b5b21fd5))
* **app:** VaultFolderSelect gains a size prop (default sm, USelectMenu sizes) ([466e9c6](https://github.com/namhtpyn/tandem/commit/466e9c62e7ed35c6fc7a94590eed050656b276ed))


### Performance Improvements

* **vault:** folder secret counts via extras correlated subquery ([5d6ece0](https://github.com/namhtpyn/tandem/commit/5d6ece07ad89b6012aed335a259b27719301bd44))

# [2.41.0](https://github.com/namhtpyn/tandem/compare/v2.40.0...v2.41.0) (2026-10-22)


### Bug Fixes

* **test:** per-worker redis DB index — pub/sub leaked across workers ([eec7464](https://github.com/namhtpyn/tandem/commit/eec7464d237d23ec174d048cc6ffe224f965f3a8))
* **test:** pin dispatcher-redis to its own redis DB via vi.hoisted ([7a109b3](https://github.com/namhtpyn/tandem/commit/7a109b3aecd685e101b3476dd05213fe5a5fa89c))
* **test:** redis DB rewrite matched no URL + state-based wait in runs-tail test ([1fe2bce](https://github.com/namhtpyn/tandem/commit/1fe2bce03faaa90ef4ec0caf9d2e71ae927213be))
* **test:** redis fanout test asserts by event id — sibling files share the worker's bus ([9394c32](https://github.com/namhtpyn/tandem/commit/9394c321238bb4102184597a797dd4672742ff9f))
* **vault:** pagination controls never advanced past page 1 ([bd8b5f6](https://github.com/namhtpyn/tandem/commit/bd8b5f6b24d22882525977053f61b361714eb6e3))


### Features

* **a11y:** Nuxt accessibility best practices — route announcer, skip link, page titles ([d831fd4](https://github.com/namhtpyn/tandem/commit/d831fd4067c73471633aa2833b46a35c979c40d5)), closes [#main](https://github.com/namhtpyn/tandem/issues/main)


### Performance Improvements

* **test:** dispatcher suite 62s -> 23s — drain exits on idle ([fe4e514](https://github.com/namhtpyn/tandem/commit/fe4e51407f145e6b3971229220de1259c9db7cd4))
* **test:** drizzle-seed reset for data tests; migrations once in global setup ([e01fb5d](https://github.com/namhtpyn/tandem/commit/e01fb5d62a372e2aac22c404e679ecf7f4e140f4))
* **test:** parallel workers, one DB per worker, savepoint resets ([bd5aa42](https://github.com/namhtpyn/tandem/commit/bd5aa429b53818a964039b75288017b2a95e4404))
* **test:** template-clone worker DBs — setup no longer dump/restores ([354a0ad](https://github.com/namhtpyn/tandem/commit/354a0ad0af76583cf0be1e3f20b161e8a29ffbd7))

# [2.40.0](https://github.com/namhtpyn/tandem/compare/v2.39.1...v2.40.0) (2026-10-21)


### Features

* **db:** drizzle-orm + drizzle-kit 1.0.0-rc.5 ([d025cce](https://github.com/namhtpyn/tandem/commit/d025cce298ee891c78e9e15cc6ca992e0fd10fe3))

## [2.39.1](https://github.com/namhtpyn/tandem/compare/v2.39.0...v2.39.1) (2026-10-21)


### Bug Fixes

* **ci:** playwright install runs plain bunx — bun's fetch trips the playwright CDN cert altnames ([94f7bc7](https://github.com/namhtpyn/tandem/commit/94f7bc79d13eea9783044107a64a02599d60cc58))

# [2.39.0](https://github.com/namhtpyn/tandem/compare/v2.38.1...v2.39.0) (2026-10-21)


### Features

* **db:** import { SQL } from 'bun' — the import pattern everywhere; every CLI runs under bun ([f45e612](https://github.com/namhtpyn/tandem/commit/f45e6122bae5e96bf499934c5aa63a0321f1f720))

## [2.38.1](https://github.com/namhtpyn/tandem/compare/v2.38.0...v2.38.1) (2026-10-21)


### Bug Fixes

* **ci:** gen:auth under node/jiti — inert drizzle handle in the CLI auth config ([bbe9273](https://github.com/namhtpyn/tandem/commit/bbe92739945a72ff4f861d19eee546346a90077a))

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
