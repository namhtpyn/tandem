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
