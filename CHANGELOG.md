## [2.78.17](https://github.com/namhtpyn/tandem/compare/v2.78.16...v2.78.17) (2026-11-11)


### Bug Fixes

* [#401](https://github.com/namhtpyn/tandem/issues/401) a review turn and its settle only act while the task still sits in review ([374ee54](https://github.com/namhtpyn/tandem/commit/374ee54058fd329a64edcfda2775cb49c5d75b38))
* [#401](https://github.com/namhtpyn/tandem/issues/401) r2 — a machine block is not an owner move; pin the parked/waiting-answer mint refusals ([4a15165](https://github.com/namhtpyn/tandem/commit/4a15165efcbfcc609838dedfe0f1663b81e73ea4))
* [#401](https://github.com/namhtpyn/tandem/issues/401) r3 — the machine-block carve-out must prove the origin is an in-review status ([7e7058f](https://github.com/namhtpyn/tandem/commit/7e7058f508eb6797b5df641ffaa8631d73d37805))
* [#401](https://github.com/namhtpyn/tandem/issues/401) r4 — the mint gate follows the round through a gating auto-block; a manual move clears both block origins ([3aeeef8](https://github.com/namhtpyn/tandem/commit/3aeeef81a4c6627e29f2f659a78798ae2299fe64))
* [#401](https://github.com/namhtpyn/tandem/issues/401) r5 — pin the park and block-landing terms; key the block arm on the paused category ([0cca009](https://github.com/namhtpyn/tandem/commit/0cca009a056794d4794079a099cbc15bfd5f30ef))

## [2.78.16](https://github.com/namhtpyn/tandem/compare/v2.78.15...v2.78.16) (2026-11-10)


### Bug Fixes

* [#406](https://github.com/namhtpyn/tandem/issues/406) dispatch claim and its RUNNING run row commit in one transaction ([100b771](https://github.com/namhtpyn/tandem/commit/100b7713fef29445f174b3136fe8aecc2120efe0))
* [#406](https://github.com/namhtpyn/tandem/issues/406) r2 — key-share the employee row before the claim (lock order), require the claim's tx + assignee, narrow the SPEC invariant ([47210f5](https://github.com/namhtpyn/tandem/commit/47210f57cbc3931f019c127634397db40af853b2)), closes [#400](https://github.com/namhtpyn/tandem/issues/400)
* [#406](https://github.com/namhtpyn/tandem/issues/406) r3 — scope the SPEC lock-order clause to a claiming dispatch ([84802f5](https://github.com/namhtpyn/tandem/commit/84802f51d292a24f530d950da8f11b3b297cfb40))
* [#406](https://github.com/namhtpyn/tandem/issues/406) r5 — the note reports what fired on a null dispatch, pin the lock mode ([29f6bc0](https://github.com/namhtpyn/tandem/commit/29f6bc0f9d2c42b93393f3a7b1116c2d8888ca2a))
* [#406](https://github.com/namhtpyn/tandem/issues/406) r6 — defer an unplannable task so one bad read cannot stall the scan; pin the claim-free review branch ([07734db](https://github.com/namhtpyn/tandem/commit/07734db43fd3024462380e754fe05df85025174a))
* [#406](https://github.com/namhtpyn/tandem/issues/406) r7 — the plan-retry deferral only pushes later (never shortens a backoff) and never fires for review turns ([d6c2ed8](https://github.com/namhtpyn/tandem/commit/d6c2ed87005d9f5b77768a1cc1afe3315fee56d9))

## [2.78.15](https://github.com/namhtpyn/tandem/compare/v2.78.14...v2.78.15) (2026-11-10)


### Bug Fixes

* [#400](https://github.com/namhtpyn/tandem/issues/400) retrain — release notes push was rejected, republish 2.78.14 as a fresh tag ([136e784](https://github.com/namhtpyn/tandem/commit/136e784e54125b775e0f95d4e321d70460682589))

## [2.78.14](https://github.com/namhtpyn/tandem/compare/v2.78.13...v2.78.14) (2026-11-10)


### Bug Fixes

* [#400](https://github.com/namhtpyn/tandem/issues/400) note/ask lifecycle flips arbitrate on the status+updatedAt they read ([29aca53](https://github.com/namhtpyn/tandem/commit/29aca5388833acaeeca6288788520f80b0e35631))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r1 — retry-once on a benign ask collision; pin the SQL connective + obligation role ([de30aa9](https://github.com/namhtpyn/tandem/commit/de30aa9ee814db5ae39fec07ba84f7d8a83d98a6))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r2 — ask authority from the pre-race read, question row in the park tx, note retry-once, user→tasks lock order ([26daf88](https://github.com/namhtpyn/tandem/commit/26daf885655b2e973f077999e1134d6e591a5ab5))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r3 — key-share every FK-referenced user row before the task row, park on the current owner, steer-gate the note retry ([6cfdc0e](https://github.com/namhtpyn/tandem/commit/6cfdc0ef8e5177dbfaccfe201b1085ad35fc5316))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r4 — never re-flip a row a dispatch claim took out of the ready category (claim-window gap filed [#406](https://github.com/namhtpyn/tandem/issues/406)) ([81b61f6](https://github.com/namhtpyn/tandem/commit/81b61f68af1ee37e7ebf6b236fae65f282950e11))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r5 — steer gate before the claim guard, vanished holder is a lost attempt, pin the locked table ([d90271b](https://github.com/namhtpyn/tandem/commit/d90271b8073ab5b786c8ccf8ee7ffdfc55001972))
* [#400](https://github.com/namhtpyn/tandem/issues/400) r6 — retry only a pure stamp bump (any status change owns the row), steer gate before every retry return, vanished user row is a lost attempt ([354aa63](https://github.com/namhtpyn/tandem/commit/354aa63bf91c9e9b6325fbcc46ec8a17dceabe8b))

## [2.78.13](https://github.com/namhtpyn/tandem/compare/v2.78.12...v2.78.13) (2026-11-10)


### Bug Fixes

* [#397](https://github.com/namhtpyn/tandem/issues/397) review-round lifecycle — abandon before teardown, stalled-review sweep, targeted review mints ([febacc6](https://github.com/namhtpyn/tandem/commit/febacc6887e68cb34b2d0582ab3195f5b1ecc227)), closes [#399](https://github.com/namhtpyn/tandem/issues/399)

## [2.78.12](https://github.com/namhtpyn/tandem/compare/v2.78.11...v2.78.12) (2026-11-10)


### Bug Fixes

* [#394](https://github.com/namhtpyn/tandem/issues/394) r4 — fault-isolate the post-commit reviewer turn + pin the landing status ([7b7dddb](https://github.com/namhtpyn/tandem/commit/7b7dddba0c68c47ea9abb6131e60ab1d58d2d817)), closes [#397](https://github.com/namhtpyn/tandem/issues/397)
* [#394](https://github.com/namhtpyn/tandem/issues/394) r5 — dispatch the reviewer turn after the parent gating write ([1afa713](https://github.com/namhtpyn/tandem/commit/1afa71362df7d7b9b48cdacbb4944d80ba75a6c5)), closes [#364](https://github.com/namhtpyn/tandem/issues/364)
* [#394](https://github.com/namhtpyn/tandem/issues/394) r6 — nothing between the commit and the reviewer turn may skip it ([5ef52c5](https://github.com/namhtpyn/tandem/commit/5ef52c57962928618eee9185b383553702893f23))
* [#394](https://github.com/namhtpyn/tandem/issues/394) the in-review flip and the review round commit in one transaction ([d1d6d7f](https://github.com/namhtpyn/tandem/commit/d1d6d7f90ed54a0195c9807d848a76b3f37a6c02))

## [2.78.11](https://github.com/namhtpyn/tandem/compare/v2.78.10...v2.78.11) (2026-11-10)


### Bug Fixes

* [#364](https://github.com/namhtpyn/tandem/issues/364) r1 review — scope the SPEC claim to the round-open window, pin the lock read's tx membership, cover the partial drop ([28fb216](https://github.com/namhtpyn/tandem/commit/28fb216d6a9a99a1f402c78e2722a8cd3ae87068))
* [#364](https://github.com/namhtpyn/tandem/issues/364) r2 review — scope the FK claim to the reviewer FK, pin the lock predicate's column/operator/value, pin the round note count, drop dead mock state ([965aa80](https://github.com/namhtpyn/tandem/commit/965aa80cbe0da516e1c116b51b475f4deb527562))
* [#364](https://github.com/namhtpyn/tandem/issues/364) reviewer-existence transaction — the round open locks the survivor user rows FOR KEY SHARE so a delete can never 23503 the submit ([a4f58ca](https://github.com/namhtpyn/tandem/commit/a4f58cacc60e727e9229be0ceefb7824202e52f4))

## [2.78.10](https://github.com/namhtpyn/tandem/compare/v2.78.9...v2.78.10) (2026-11-09)


### Bug Fixes

* [#386](https://github.com/namhtpyn/tandem/issues/386) r1 review — guard the channel tokenSecretId; pin nested leaves, blank ids and the shared registryUpdate field ([44eb43f](https://github.com/namhtpyn/tandem/commit/44eb43f25a2d9453bbcd6c4389b4270d65caf120))
* [#386](https://github.com/namhtpyn/tandem/issues/386) r2 review — guard the oidc provider id and channel platformUserId, refuse whitespace-only ids, add the router-completeness pin ([a788281](https://github.com/namhtpyn/tandem/commit/a788281c0beaba6a7928281c7c0c8e64e5084154))
* [#386](https://github.com/namhtpyn/tandem/issues/386) r3 review — pad/blank id refusal, employee id sweep, path-aware completeness pin ([8a66e6d](https://github.com/namhtpyn/tandem/commit/8a66e6d5f46dfe932276c66938668cdab34b7894))
* [#386](https://github.com/namhtpyn/tandem/issues/386) r4 review — edge-only channel guard, ref-vs-store id split, hardened completeness harness ([baddaa7](https://github.com/namhtpyn/tandem/commit/baddaa74a9b4ac6b74cbff2f59e9d419c97eb845))
* [#386](https://github.com/namhtpyn/tandem/issues/386) r5 review — dispatch miss answers NOT_FOUND, grapheme-safe pad rule, exact-set completeness pin ([4a419d5](https://github.com/namhtpyn/tandem/commit/4a419d556141bc498df45cbb558d2cd43e1d903c))
* [#386](https://github.com/namhtpyn/tandem/issues/386) r6 review — pad-edge base check, uuid-filter misses stay misses, residual pins ([5e7d21b](https://github.com/namhtpyn/tandem/commit/5e7d21bb1ef758fa4edb0e4d1c6855a1e854f87f))
* [#386](https://github.com/namhtpyn/tandem/issues/386) refuse unstorable text in every text-typed id parameter at the schema edge ([33fc94b](https://github.com/namhtpyn/tandem/commit/33fc94bc48d67be78203bb69d43929a5c483dbb6))

## [2.78.9](https://github.com/namhtpyn/tandem/compare/v2.78.8...v2.78.9) (2026-11-09)


### Bug Fixes

* [#382](https://github.com/namhtpyn/tandem/issues/382) apply the storable-text guard to every raw text write and refuse unstorable search filters ([c7e09cb](https://github.com/namhtpyn/tandem/commit/c7e09cbfbcbb23d8d75d1084122a387de365e2db))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r1 review — guard the URL columns, make the vault last-four hint pair-aware, close the vacuity gaps ([7f6b2fb](https://github.com/namhtpyn/tandem/commit/7f6b2fbb1203f8fd88eed17198ebde3f8db1f509))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r2 review — guard better-auth user creation, align the last-four gate with its slice, pin the label wiring and the literal null clears ([040d9d7](https://github.com/namhtpyn/tandem/commit/040d9d7f119ec46c928007ad9154d917d7967cc7))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r3 review — pin the update null clears, the parsed-default axis, the vault hint write path; precise the [#386](https://github.com/namhtpyn/tandem/issues/386) carve-out ([988ad9b](https://github.com/namhtpyn/tandem/commit/988ad9b15f81aeb07efe911847523e9da0e87f08))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r4 review — pin the null-refusal direction, name the non-schema edges honestly, drop the over-bound assertions ([f440ec8](https://github.com/namhtpyn/tandem/commit/f440ec81a75c24b01e6866e45eea929dcb954d7e))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r5 review — split the shape-gate from the set-compare in the [#386](https://github.com/namhtpyn/tandem/issues/386) carve-out, pin the extraHeaders omission and the hook cancel path ([a913186](https://github.com/namhtpyn/tandem/commit/a913186e1c78571f7f728ac77024acea6354e705))
* [#382](https://github.com/namhtpyn/tandem/issues/382) r6 review — pin required-field omission and the empty-string value form, qualify the nextIds self-edge ([10ea2c5](https://github.com/namhtpyn/tandem/commit/10ea2c5b6413cfead6a57f1f6552f641053c1244))

## [2.78.8](https://github.com/namhtpyn/tandem/compare/v2.78.7...v2.78.8) (2026-11-09)


### Bug Fixes

* [#377](https://github.com/namhtpyn/tandem/issues/377) employee text is storable or refused — NUL and lone surrogates answer BAD_REQUEST, never the driver's 500 ([3daf738](https://github.com/namhtpyn/tandem/commit/3daf7383dc78c594e0779549f1387af8b4beaac5))
* [#377](https://github.com/namhtpyn/tandem/issues/377) r1 review — restore model's min(1), guard the avatar data URL, field-truthful titles.save label, correct the driver-mechanism claim (NUL throws; lone surrogate is rewritten to U+FFFD), pin every wiring ([008eb9e](https://github.com/namhtpyn/tandem/commit/008eb9ea9bdbf5f2b66c98d5013e14d7140b0487))
* [#377](https://github.com/namhtpyn/tandem/issues/377) r2 review — guard the text-typed employee ids (environment/provider/secret/title id), pin pair-continuation bounds, blankness contract and the instructions helper swap ([59da66c](https://github.com/namhtpyn/tandem/commit/59da66c1491fbf428cf9c69f001aad164426731a))
* [#377](https://github.com/namhtpyn/tandem/issues/377) r3 review — guard the titles.remove text id, widen the blankness pins to every non-blank field ([eeee51c](https://github.com/namhtpyn/tandem/commit/eeee51cc164bab285554f0b6ead9706c2f1e8f9c))

## [2.78.7](https://github.com/namhtpyn/tandem/compare/v2.78.6...v2.78.7) (2026-11-09)


### Bug Fixes

* [#370](https://github.com/namhtpyn/tandem/issues/370)/[#371](https://github.com/namhtpyn/tandem/issues/371) reviewer turn removal — a deleted reviewer’s in-flight turn never parks the round, and the sequential queue advances ([#379](https://github.com/namhtpyn/tandem/issues/379)) ([723e089](https://github.com/namhtpyn/tandem/commit/723e0899da19a039d1462b290c08dfdf0f9a2d6f))

## [2.78.6](https://github.com/namhtpyn/tandem/compare/v2.78.5...v2.78.6) (2026-11-09)


### Bug Fixes

* [#367](https://github.com/namhtpyn/tandem/issues/367) — access-key names always fit the plugin cap; over-cap caller names are BAD_REQUEST ([6bd3390](https://github.com/namhtpyn/tandem/commit/6bd3390d4a700f44e4317664e90a686d10bf80ec))
* [#367](https://github.com/namhtpyn/tandem/issues/367) r2 review — code-point truncation, UTF-16 cap measure, derived-branch pins ([eda35db](https://github.com/namhtpyn/tandem/commit/eda35dbf0f467655776345303a26fac791b19529))
* [#367](https://github.com/namhtpyn/tandem/issues/367) r3 review — inclusive suffix boundary, UTF-16 wording, well-formed derived names, exact astral pins ([8decc82](https://github.com/namhtpyn/tandem/commit/8decc82bb5e1bf14f8706cce87916188845c2f9b))
* [#367](https://github.com/namhtpyn/tandem/issues/367) r4 review — refuse unstorable names (NUL/lone surrogate), pin rename accept and stored name ([b813144](https://github.com/namhtpyn/tandem/commit/b81314484fe6c46de80cb4e3f8acddb6047dbcd8))
* [#367](https://github.com/namhtpyn/tandem/issues/367) r5 review — pin lone-low surrogate, 32-unit mint, blank rename; scope the SPEC edge claims ([bcd5dc6](https://github.com/namhtpyn/tandem/commit/bcd5dc64f35e7fd6e1338460ebfd0e3a296a9287))
* [#367](https://github.com/namhtpyn/tandem/issues/367) r6 review — drop the unit-boundary SPEC claim, pin whitespace-only mint and mint-side refusal ([15be01c](https://github.com/namhtpyn/tandem/commit/15be01c2f4f5615286726b0f8567cc536e7cfa72))

## [2.78.5](https://github.com/namhtpyn/tandem/compare/v2.78.4...v2.78.5) (2026-11-08)


### Bug Fixes

* [#369](https://github.com/namhtpyn/tandem/issues/369) answer-holder removal — a departed holder's pending answer never strands the task ([ecacba7](https://github.com/namhtpyn/tandem/commit/ecacba777f04d187854519c76110994268d92a3c))
* [#369](https://github.com/namhtpyn/tandem/issues/369) r1 review — trigger last, existential holder guard, orphan sweep ([5dafee7](https://github.com/namhtpyn/tandem/commit/5dafee7994d6c56f0ae989d052fbb7b57fec92c0))
* [#369](https://github.com/namhtpyn/tandem/issues/369) r2 review — extinguished-round matrix, scoped teardown, signature-preserving lost flip ([ba4b100](https://github.com/namhtpyn/tandem/commit/ba4b10087fa0d24cbfd40269f852cf70b73e009f))
* [#369](https://github.com/namhtpyn/tandem/issues/369) r3 review — re-fire before teardown, signature-preserving errors, forward CAS ([ce9d32e](https://github.com/namhtpyn/tandem/commit/ce9d32e36685f00626e85433530d32aa5c57b8fd))
* [#369](https://github.com/namhtpyn/tandem/issues/369) r4 review — blocked-task signature, crash-repair matrix, post-spawn forward arbitration ([a134bce](https://github.com/namhtpyn/tandem/commit/a134bce44b3dc40070a694f443c264ed9bb00680)), closes [#365](https://github.com/namhtpyn/tandem/issues/365)
* [#369](https://github.com/namhtpyn/tandem/issues/369) r5 review — blocked take keeps its rows, queue ignores NULL holders, restore heal ([8906d25](https://github.com/namhtpyn/tandem/commit/8906d25d77368ed6bc5f23be173119e238029436))
* [#369](https://github.com/namhtpyn/tandem/issues/369) r6 review — restore heal keys on the machine signature, failed re-fire parks ([63dc452](https://github.com/namhtpyn/tandem/commit/63dc452bbef333558abcd9ec25fd8280fc0c049b))
* [#369](https://github.com/namhtpyn/tandem/issues/369) watchdog — orphaned ANSWER holder arm (NULL-holder PENDING answer, [#369](https://github.com/namhtpyn/tandem/issues/369) class) ([c479e7e](https://github.com/namhtpyn/tandem/commit/c479e7ead75ae79d4870d72aba7e000f38de246e))

## [2.78.4](https://github.com/namhtpyn/tandem/compare/v2.78.3...v2.78.4) (2026-11-08)


### Bug Fixes

* [#365](https://github.com/namhtpyn/tandem/issues/365) r1 review — settle every restore/answer path, act only after the delete, pin the scopes ([dc36a69](https://github.com/namhtpyn/tandem/commit/dc36a69ddf1e09ecf0bd61f543baae0fcb5b827d)), closes [#361](https://github.com/namhtpyn/tandem/issues/361)
* [#365](https://github.com/namhtpyn/tandem/issues/365) r2 review — gating-only restores, the round-open race, fault-isolated removal, pinned scopes ([ab8fc82](https://github.com/namhtpyn/tandem/commit/ab8fc82840caad81745de0ca039cd298b371dfb1)), closes [#292](https://github.com/namhtpyn/tandem/issues/292) [#369](https://github.com/namhtpyn/tandem/issues/369)
* [#365](https://github.com/namhtpyn/tandem/issues/365) r3 review — flip first, re-gate parents, drop the answer hook, bound the sweeps ([a97845c](https://github.com/namhtpyn/tandem/commit/a97845c7166b856f875fb1f5486f0a72804e81e3)), closes [#361](https://github.com/namhtpyn/tandem/issues/361) [#370](https://github.com/namhtpyn/tandem/issues/370)
* [#365](https://github.com/namhtpyn/tandem/issues/365) r4 review — keep the void row while a task is blocked, owner reopen wins, drop rather than cancel ([d1741ed](https://github.com/namhtpyn/tandem/commit/d1741ed8a165fa5202a76d2faca6db5bfe1fe87b)), closes [#370](https://github.com/namhtpyn/tandem/issues/370) [#369](https://github.com/namhtpyn/tandem/issues/369)
* [#365](https://github.com/namhtpyn/tandem/issues/365) r5 review — heal the terminal residue, discard on reopen, drop the holder's rows ([84bf1e2](https://github.com/namhtpyn/tandem/commit/84bf1e21ec4a1c0566107069ba74d1fbb626ae5f)), closes [#371](https://github.com/namhtpyn/tandem/issues/371) [#370](https://github.com/namhtpyn/tandem/issues/370) [#369](https://github.com/namhtpyn/tandem/issues/369)
* [#365](https://github.com/namhtpyn/tandem/issues/365) r6 review — trigger last, disarm the ladder, isolate the restore heals ([4482f62](https://github.com/namhtpyn/tandem/commit/4482f62f6151df690d591001da1fa5271a1c1c69)), closes [#369](https://github.com/namhtpyn/tandem/issues/369)
* [#365](https://github.com/namhtpyn/tandem/issues/365) reviewer removal — a deleted reviewer's pending row is a non-vote, never a wedge ([7bcd76b](https://github.com/namhtpyn/tandem/commit/7bcd76b1c84b8ca9c1dcc459ca5e9421da8a27af))

## [2.78.3](https://github.com/namhtpyn/tandem/compare/v2.78.2...v2.78.3) (2026-11-08)


### Bug Fixes

* **tasks:** reviewer existence at both ends ([#361](https://github.com/namhtpyn/tandem/issues/361)) ([cceabe9](https://github.com/namhtpyn/tandem/commit/cceabe9f870f398d56d1529f88af512a5fe98aec)), closes [#364](https://github.com/namhtpyn/tandem/issues/364) [#365](https://github.com/namhtpyn/tandem/issues/365)

## [2.78.2](https://github.com/namhtpyn/tandem/compare/v2.78.1...v2.78.2) (2026-11-08)


### Bug Fixes

* **api:** ID-SHAPE LAW — malformed uuid ids answer the specced miss, never a 22P02 500 ([#358](https://github.com/namhtpyn/tandem/issues/358)) ([87e8a1e](https://github.com/namhtpyn/tandem/commit/87e8a1e0f7c6c8e8a72a6d7915da56b455b2c206))
* **api:** r1 review — forward target guarded, probe answers the lookup miss, blank binding filter, law scoped to uuid columns ([5c99aaf](https://github.com/namhtpyn/tandem/commit/5c99aaf54c72c685ca9e63207661e965f7a02012))
* **api:** r2 review — supervisor ids canonicalized, blank read inputs, shape-first task writes ([49b1a70](https://github.com/namhtpyn/tandem/commit/49b1a708d8364603123179d2a4e74d664e52fe06))
* **api:** r3 review — malformed supervisor ids get their own message, mirror case pinned ([02b6a30](https://github.com/namhtpyn/tandem/commit/02b6a30c6ab443dcde0c84cf3ecefb3b9c8968c9))
* **api:** r4 review — task refs canonicalized, supervisor shape before the lookup, per-field malformed messages ([c845d18](https://github.com/namhtpyn/tandem/commit/c845d18a99ab70d05f3038f60a81a21235618ecc))
* **api:** r5 review — keep the projectId existence check, canonicalize the forward target ([c3e02ce](https://github.com/namhtpyn/tandem/commit/c3e02ce78656e7d5d65651a80fcf9ee0a4e85c84))

## [2.78.1](https://github.com/namhtpyn/tandem/compare/v2.78.0...v2.78.1) (2026-11-08)


### Bug Fixes

* **authz:** access-key reads are self-or-admin; malformed ids are a miss ([#356](https://github.com/namhtpyn/tandem/issues/356)) ([aa186bf](https://github.com/namhtpyn/tandem/commit/aa186bf448e067ddf6e7ac8b5815c1e141e8de45))
* **authz:** r1 review — pin the shape guard on the ADMIN leg, scope the key-material sentence, state the canonical-id contract ([00c90d6](https://github.com/namhtpyn/tandem/commit/00c90d6cad00ac4a4518821f63a0d71bee00371d))

# [2.78.0](https://github.com/namhtpyn/tandem/compare/v2.77.0...v2.78.0) (2026-11-08)


### Bug Fixes

* **tasks:** r1 review — non-uuid assignee ids are a miss, not a 500; create CTA gated; one URL normalizer ([#353](https://github.com/namhtpyn/tandem/issues/353)) ([b7d17de](https://github.com/namhtpyn/tandem/commit/b7d17def20b2585d71aa54667aadeca068236f0a))


### Features

* **tasks:** assignee scope — server filter, ?assignee= URL state, My tasks ([#353](https://github.com/namhtpyn/tandem/issues/353)) ([a565909](https://github.com/namhtpyn/tandem/commit/a565909122599c60091c4e0028dadf56a009b128))

# [2.77.0](https://github.com/namhtpyn/tandem/compare/v2.76.1...v2.77.0) (2026-11-07)


### Bug Fixes

* **test:** r2 — top-level fetch mock reset + acp fake statics reset ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([ba87066](https://github.com/namhtpyn/tandem/commit/ba87066d0bb6f352177951008db0c6337920707e))
* **test:** r2 blind review — parse with a real AST, per-holder opt-out ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([d4c9247](https://github.com/namhtpyn/tandem/commit/d4c9247b0702f0f9fe354e01d1fc7d212bbbdd12))
* **test:** r3 — enforce hoisted isolation at runtime, not by static analysis ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([1918b7d](https://github.com/namhtpyn/tandem/commit/1918b7d59ab0c9ccd09f26943dcdff74e40faa36))
* **test:** r4 — harden the isolation harness (cycles, getters, Date, symbols) ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([3748dd6](https://github.com/namhtpyn/tandem/commit/3748dd6969cec45d64cbb83886cd78fd16c89a39))
* **test:** r5 — close the harness blind spots round 4 proved ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([62ed0cb](https://github.com/namhtpyn/tandem/commit/62ed0cb3e03bad50e9e37a8fbfe0ec45cf56af74))
* **test:** r6 — register function holders, per-view byte restore, container expandos ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([4b5bd3f](https://github.com/namhtpyn/tandem/commit/4b5bd3ffbd8b509a429cdebc09a9d98d89e88a39))
* **test:** r7 — frozen-safe restore, deleted-key restore, expandos pinned ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([2e25fde](https://github.com/namhtpyn/tandem/commit/2e25fdec5494d68798e417c702fc1b430216daa0))
* **test:** reset every mutated vi.hoisted holder + guard the rule ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([3ed17a0](https://github.com/namhtpyn/tandem/commit/3ed17a0fedd019b535d59ce6193915395ab72fb8))
* **test:** reset module-level fixture state per test ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([efc725f](https://github.com/namhtpyn/tandem/commit/efc725fcfd7fefd34a6821d3a13c1c4ee1ee5924))


### Features

* **shell:** decision queue visibility — Tasks nav badge, ?inbox=1 deep link, mobile navbar pill ([#350](https://github.com/namhtpyn/tandem/issues/350)) ([0462ee6](https://github.com/namhtpyn/tandem/commit/0462ee6d477623a21a0b8583e59401d3dcf7013b))

## [2.76.1](https://github.com/namhtpyn/tandem/compare/v2.76.0...v2.76.1) (2026-11-07)


### Bug Fixes

* **mcp:** r1 blind review — a refused handshake takes the child's exit/stderr verdict immediately (P2) ([c1e7674](https://github.com/namhtpyn/tandem/commit/c1e7674d7358c6c797c46fa513dbf38f14eb16cd))
* **mcp:** r2 blind review — first-line stderr reader (no drain-to-EOF), stderr wins on every null-parsed exit (P2) ([56c10ba](https://github.com/namhtpyn/tandem/commit/56c10ba3174f7ce3020318a9e4770d84aa2969dc))
* **mcp:** r3 blind review — complete stderr lines, timeout keeps the child's reason (P3/P2) ([516613f](https://github.com/namhtpyn/tandem/commit/516613f50420037a00983e04234c5ac8efd70698))
* **mcp:** stdio probe never reports a bare EPIPE in place of the child's stderr ([#346](https://github.com/namhtpyn/tandem/issues/346)) ([1458f5c](https://github.com/namhtpyn/tandem/commit/1458f5ca99c596e4bfe253cbd25b55638f48746a))
* **tasks:** task detail carries the list scope so back returns to it ([#341](https://github.com/namhtpyn/tandem/issues/341)) ([c56189d](https://github.com/namhtpyn/tandem/commit/c56189db3dd621201e8ccb641c293e204035a417))

# [2.76.0](https://github.com/namhtpyn/tandem/compare/v2.75.1...v2.76.0) (2026-11-06)


### Bug Fixes

* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r1 blind review — scope-aware empty copy in every composed state, NONE_ID sentinel is never a scope, composed-where unit pin, e2e covers select-set / unknown id / sentinel ([a37af1f](https://github.com/namhtpyn/tandem/commit/a37af1f3f264f942c1f927516be2c3cf9f05385c))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r2 blind review — strip the dead project param on mount, pin the scoped obligation copy + mobile drill-down in e2e, README user-impact update ([8802b74](https://github.com/namhtpyn/tandem/commit/8802b74c07513dd0d7051470bfec6e0f0dbb2323))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r3 blind review — filter-relative scoped empty copy + URL normalization for multi-valued project params ([f7de64c](https://github.com/namhtpyn/tandem/commit/f7de64c64bb55f37fe044d5d1d4969137490c265))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r4 blind review — scoped create inherits the project (P2 dead end), empty-project CTA under scope, URL normalization covers blank/untrimmed shapes ([5156063](https://github.com/namhtpyn/tandem/commit/5156063f80236866955d1d0a9d40dceb43a14e78))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r5 blind review — create default only for a RESOLVABLE scope, obligation copy composes with an active search, empty-state CTA e2e pin ([f96823b](https://github.com/namhtpyn/tandem/commit/f96823bee1291bdd28552f311021ba95f9bd8e1f))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r6 blind review — create default is CREATE-ONLY (P2: an edit never inherits the scope), obligation copy names a live status chip, scoped empty CTA hides on an unresolvable scope ([bdcbedf](https://github.com/namhtpyn/tandem/commit/bdcbedf9397a81f2b5fc144385e6568a72ca4ed4))
* **tasks:** [#339](https://github.com/namhtpyn/tandem/issues/339) r7 final review — empty-state create only on a bare scope (no duplicate-create loop), obligation copy names both toggles ([398de5f](https://github.com/namhtpyn/tandem/commit/398de5f9fe987df9557ac71979ae25f2bdb8b591))


### Features

* **tasks:** project scope on the paged task list — project rows drill down, ?project= URL-synced ([#339](https://github.com/namhtpyn/tandem/issues/339)) ([fcccc18](https://github.com/namhtpyn/tandem/commit/fcccc1897ee3fa443304a1f0ba156ed9aa5abb5b))

## [2.75.1](https://github.com/namhtpyn/tandem/compare/v2.75.0...v2.75.1) (2026-11-06)


### Bug Fixes

* **tasks:** [#336](https://github.com/namhtpyn/tandem/issues/336) category-gate sweep — lifecycle gates resolve task_statuses categories, never seeded status ids ([fcc4f21](https://github.com/namhtpyn/tandem/commit/fcc4f216ddb2ccfdcf7a7b5f2ffd9baef558fba4))
* **tasks:** [#336](https://github.com/namhtpyn/tandem/issues/336) r1 blind review — abandon named in the law + re-categorization caveat, unblock-resume leaf helper unit-pinned, mocks honor the where predicate ([d27af48](https://github.com/namhtpyn/tandem/commit/d27af48019c487a965d746bdda531c648256d54d))

# [2.75.0](https://github.com/namhtpyn/tandem/compare/v2.74.0...v2.75.0) (2026-11-06)


### Bug Fixes

* **ops:** arm probe detectors caught by blind review ([#332](https://github.com/namhtpyn/tandem/issues/332)) — health word match (unhealthy), retention epoch-ms->s, JSON creep scan, version-floor bootstrap, tag-oracle/profile guards, age-normalized dedupe, quoted CT array; add check-probe-drift + selfcheck tests ([db7ed53](https://github.com/namhtpyn/tandem/commit/db7ed5397007a7722dd12338ed9f38481fbb0f01))
* **ops:** r2 review — ghostset settings-absent fallback (P1), loud version-RPC + column-guard failures, fetch-first drift check with stale-ref test, deploy window from first sighting (lightweight tags), context-aware creep scan ([15d735f](https://github.com/namhtpyn/tandem/commit/15d735fd542c254ce5578a51a1740b40a516cccc))
* **ops:** r3 review — age-normalized dedupe for space-formatted ages, explicit-refspec drift fetch, feature-floor constants (fresh state dir cannot arm old image), connected-only channel sync, queue probe sentinel + real redis container ([0c47508](https://github.com/namhtpyn/tandem/commit/0c47508dc571f9add59c5faabbbbce69b2905436))
* **ops:** r4 review — queue leg back on the TANDEM work redis (verified keys), wedge/strand 2-consecutive presence confirm, loud unwritable-state and unreadable-mismatch paths, retention nullif cast, P0 label from anomaly class, tag oracle via gh releases, test-mode drift exit 3 ([02e5b86](https://github.com/namhtpyn/tandem/commit/02e5b86b4e128128a68f4cb2d7079142abc2f8a8))
* **ops:** r5 review — chan_stamp absent arm (scalar subselect), overlap-marker validation, loud creep scan failures, drift checker hardcoded live path + origin assert + limited-refspec test, inspection-run trail guard ([8882bc6](https://github.com/namhtpyn/tandem/commit/8882bc6a056772b1e92fec109dfdd0b753854622))
* **ops:** r6 cap review — canonicalize overlap marker via date (no raw interpolation), clamp future mismatch stamps + clear only on catch-up, sum all wait queues, exact upstream URL check, atomic --deploy with size verification ([013d2a5](https://github.com/namhtpyn/tandem/commit/013d2a52affde1a64d77b220b6e3ac9d8aff99ef))
* **ops:** validate the mismatch-since stamp (non-numeric state cannot crash the version arm) ([d9e8223](https://github.com/namhtpyn/tandem/commit/d9e8223f857636d6095431b5bb09df38db5a879c))
* **tasks:** r1 blind review — retire the optimistic pick after the authoritative refetch, splice the row's own assignee into options (no raw id while the employees query trails), lock-icon affordance on the inline selects, e2e waits for the post-mutation line + reloads before asserting ([ea49c8e](https://github.com/namhtpyn/tandem/commit/ea49c8e668831175f6c62c147936348026c3f887))
* **tasks:** r2 blind review — keep the optimistic pick when the refetch failed (no success banner over a reverted control), e2e holds the update to prove the optimistic flip, board covers forward assign + clear, viewer gate asserts no assignee control ([6c19d70](https://github.com/namhtpyn/tandem/commit/6c19d706cb83defb0ad8b349f64a9347033ca33d))
* **tasks:** r3 blind review — retire the assign overlay on the first post-write fetch (differing values included), 44px card tap targets, dialog-scope the editor assignee combobox (row comboboxes made the old locator ambiguous), e2e covers card optimism, mobile card and run lock ([1b63729](https://github.com/namhtpyn/tandem/commit/1b637293cba8940d5c30000f0a13eb0e243a6e9a))


### Features

* **tasks:** inline assignee edit on list rows and cards ([#333](https://github.com/namhtpyn/tandem/issues/333)) ([e5e6f1a](https://github.com/namhtpyn/tandem/commit/e5e6f1a60be3b09dc46727f469ead765c4dcd071))

# [2.74.0](https://github.com/namhtpyn/tandem/compare/v2.73.0...v2.74.0) (2026-11-06)


### Bug Fixes

* [#266](https://github.com/namhtpyn/tandem/issues/266) r1 review — leg-1 drain advances (blanked rows excluded from the scan: without the output<>''/prompt-null arm the same oldest 500 re-qualified forever), SPEC audit-row scope made explicit (leg 1 keeps every row; legs 2/3 delete only non-actionable state), regression pin for the exclusion arm ([1e98b96](https://github.com/namhtpyn/tandem/commit/1e98b96fa00bfae624f40f540bd2f894bbf18f86))
* [#266](https://github.com/namhtpyn/tandem/issues/266) r2 review — re-entry guard (one retention pass at a time; a pass slower than the 5s tick can no longer stack duplicates), SPEC watchdog sentence margin-keyed (stable-or-growing count across 2 passes = dead leg — a draining leg is silent; matches reaper-watchdog form + the shipped probe), tests pin the warn rate-limit window, both stamp-cache arms, executor pass-through and the re-entry guard ([635cf0e](https://github.com/namhtpyn/tandem/commit/635cf0e981d7360fd6928fd0627d06531403f248))
* [#266](https://github.com/namhtpyn/tandem/issues/266) r3 review — re-entry flag set synchronously before the first await (TOCTOU: a stalled settings read can no longer re-admit the next tick; single finally clears on every path), SPEC watchdog contract rewritten margin-keyed (stamp-age >25h arm + day-over-day drain-shrink arm; a shrinking multi-day drain is legal and silent — count-stability at probe cadence was stable-by-construction), write-shape pins wired to the service's real calls via a recording executor (table identity, exact blank set, id-scoped where) replacing hand-built replicas ([8ab8ca4](https://github.com/namhtpyn/tandem/commit/8ab8ca4453c9d843f480d091d8fbae4de90b6322))
* [#266](https://github.com/namhtpyn/tandem/issues/266) r4 review — watchdog reduced to the sound mechanism arm (stamp-age >25h, heartbeat-shaped; absent key silent): the count-fails-to-shrink arm was state-keyed and false-alerts at equilibrium (steady inflow < batch/day leaves the backlog flat on a healthy leg) — the retained count is operational data, never an alarm; over-batch inflow is a capacity decision, not a page ([b76aefc](https://github.com/namhtpyn/tandem/commit/b76aefcbbc2de3e5ed8ddf61d93c7880f8379437))
* [#266](https://github.com/namhtpyn/tandem/issues/266) r5 review — cache arm anchors retentionState.lastAt to the persisted STAMP value, not boot time (both lenses converged: lastAt=now() re-armed the 24h skip from every restart, sliding cadence to ~48h under restart-heavy ops and breaking the watchdog's 25h margin); fake-timer pin proves fire-on-stamp-24h ([990037f](https://github.com/namhtpyn/tandem/commit/990037fca8350df3d53518464edab097c3ee868b))
* [#266](https://github.com/namhtpyn/tandem/issues/266) r6 review (cap round) — (1) failure path backs off 15m instead of next-tick re-entry (a persistent leg-2/3 failure could blank another batch every 5s), (2) retention_last_attempt stamp at pass start + two-arm watchdog (not-running / runs-but-never-completes; absent-run alone could not distinguish them), (3) leg 2 keeps resolved rows on tasks that still carry a PENDING obligation (a live approval round displays its approved tally; deleting them regressed 2/3 to 0/3), (4) SPEC schema-line carve-out for the blanking law, (5) dispatcher wiring source-pin test; live-PG probes prove drain advance + open-round survival ([5b91a81](https://github.com/namhtpyn/tandem/commit/5b91a81a7df3c6b6e248afdaab862ed078c44e2b))


### Features

* [#266](https://github.com/namhtpyn/tandem/issues/266) daily retention leg — transcripts blanked on settled terminal runs past horizon (rows kept), resolved obligations + expired sessions deleted, settings-stamp throttled tick leg; SPEC RETENTION LAW; shape+behavior tests ([8bfa4be](https://github.com/namhtpyn/tandem/commit/8bfa4be64c503b89e8d3e529671a26eb30094367))

# [2.73.0](https://github.com/namhtpyn/tandem/compare/v2.72.0...v2.73.0) (2026-11-06)


### Bug Fixes

* [#271](https://github.com/namhtpyn/tandem/issues/271) r1 review — stale-timer re-arm strand (null the cleared handle: a partial start after a clean settle had zero retries), config edits under an unchanged adapter key restart the adapter (running adapters captured the old token), key-identity editor/toggle/delete (SSE refetch could clobber the wrong row or report a removal that never landed), canonical adapter key in channels.list, dropped rows lose live controls, non-blocking re-arm, stopChannels disarms the re-arm, start-chain + empty-write test pins ([66415f2](https://github.com/namhtpyn/tandem/commit/66415f2ca57252966b9ca14479e07c945dd22b08))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r2 review — stopped invariant enforced (stopChannels disarms re-arm + retry timer; hook no-ops when stopped), db mock honors where predicates (predicate law), re-arm spy pin on the update verb, admin hygiene: same-key duplicates refused regardless of enabled flag + nested-strict bindings schema, mobile card parity (reason/bindings/health), unique v-for keys ([34d666c](https://github.com/namhtpyn/tandem/commit/34d666c8032f3727d58e71964c5478d4ed807711))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r3 review — stopChannels joins the start chain (a stop racing an in-flight re-arm start can no longer leave live adapters + health tick after the stop returns; direct startChannels stays a deliberate restart), refused delete renders its reason inside the confirm modal ([9426255](https://github.com/namhtpyn/tandem/commit/9426255d1020a7443c693b3c9afe053805282d69))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r4 review — deleting a dropped duplicate row routed its shared canonical key into the ok-row filter and removed the VALID channel; delete now branches on row kind (ok-row = key filter, dropped row = replace-drop), e2e pins the surviving channel ([a1a7893](https://github.com/namhtpyn/tandem/commit/a1a78935c183991b6524ba355db435d4e514f4e4))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r5 review — row ops switch key to content identity (same-key enabled+disabled twins each keep their own rows; toggle/edit/delete can no longer clobber the twin), save-refused schema reason surfaced in the card, editor refuses when the row changed under it, editor modal title/submit labels follow the fingerprint refactor; e2e pins the twin delete ([127b4c6](https://github.com/namhtpyn/tandem/commit/127b4c6444d5e851b99fbfffb58c545f967d7aa0))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r6 decision — atomic CAS (the base check IS the write: one conditional UPDATE keyed on date_trunc('milliseconds', updated_at); null base = insert-or-nothing so a row that appeared under us refuses), single-row list snapshot (value + base read together — no torn base newer than the entries it accompanies), health stamp element guard (channels:[null] still crashed the card render), ms-precision base comparison (postgres-now() seeded rows carry microseconds the ISO base cannot express — bare equality refused every write) ([1568b2b](https://github.com/namhtpyn/tandem/commit/1568b2bd3e9e94f795f73fd11620d7fdad99bab7))
* [#271](https://github.com/namhtpyn/tandem/issues/271) r6 review — optimistic concurrency on channels.update (a drifted baseUpdatedAt refuses the replace instead of silently dropping another admin's rows; card sends the rendered updatedAt and refetches after each write), exact-content duplicates collapse to one channel in inspection (identical same-key twins collided card fingerprints — delete-one removed both), channels.list shape-guards the health stamp (valid-JSON wrong-shape stamp crashed the card render), serialization test observes the real start chain (3 concurrent starts, max 1 adapter start in flight — the old pin passed with the chain deleted) ([b81661f](https://github.com/namhtpyn/tandem/commit/b81661fe1c6154e44be3c3ebe9196ac39a38dfce))


### Features

* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 4 — channels settings UI: admin list/update verbs on the channels key, strict admin-path validation through the same per-entry inspection as the runtime parser, in-process adapter re-arm, settings card with create/edit/delete/toggle + dropped-entry visibility ([f0c7792](https://github.com/namhtpyn/tandem/commit/f0c7792f4e1e2c0ce86a5fc50a8e85c228718796))

# [2.72.0](https://github.com/namhtpyn/tandem/compare/v2.71.0...v2.72.0) (2026-11-05)


### Bug Fixes

* [#325](https://github.com/namhtpyn/tandem/issues/325) r1 review — healthCap disambiguates null (never-synced vs capability-absent: a from-boot outage held connected:true+null with no alertable signal), per-entry try covers isLive too (a throwing isLive killed the whole stamp), fetch stub moved per-test (unstubGlobals:true made the module-level stub inert = real DNS in unit tests), lifecycle test pins tick REFRESH + asserts the stub fired ([d492b16](https://github.com/namhtpyn/tandem/commit/d492b16bf70e716de7c2ebc44535808508188e29))
* [#325](https://github.com/namhtpyn/tandem/issues/325) r2 review — healthOk flags a FAILED health read (a throwing health() on a live adapter must not fabricate the never-synced alert shape), parse-dropped enabled configs stamp connected:false (unknown kind was invisible to every alarm channel), per-read isolation (throwing isLive degrades to connected:false without faking a health fault) ([33ec40e](https://github.com/namhtpyn/tandem/commit/33ec40e1291b7612b5fd33cb62f0810ceeb68892))
* [#325](https://github.com/namhtpyn/tandem/issues/325) r2 review — healthOk flags a FAILED health read (a throwing health() on a live adapter must not fabricate the never-synced alert shape), parse-dropped enabled configs stamp connected:false (unknown kind was invisible to every alarm channel), per-read isolation; complexity gate: extract healthEntryFor + parseDroppedEntries helpers ([39dffef](https://github.com/namhtpyn/tandem/commit/39dffeff9cb152913727d1418e06cc1422956143))
* [#325](https://github.com/namhtpyn/tandem/issues/325) r3 followup — healthFn narrowing (no non-null assertion, typecheck-clean) ([e8653e6](https://github.com/namhtpyn/tandem/commit/e8653e6eff5ec95df09fe83720c61a5d2d63cab1))
* [#325](https://github.com/namhtpyn/tandem/issues/325) r3 review — canonical-key law in parseDroppedEntries (raw-vs-canonical key mismatch grew a phantom connected:false entry for every kept config stored under a non-canonical URL = permanent false adapter-down alert), healthOk means a read HAPPENED (missing adapter/health = false, consistent with dropped entries), SPEC honesty: restart-into-dead-homeserver shows connected:false (whoami fails, adapter never registers), never-synced shape is start-ok-then-transport-fails ([5844d6c](https://github.com/namhtpyn/tandem/commit/5844d6cbc9ede1db85c31179939accddf9bb2be6))


### Features

* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 3 — channel watchdog health (SPEC first: channels:health stamp contract) ([181a44a](https://github.com/namhtpyn/tandem/commit/181a44a27f148de91f8f1f2d5a0b0a07fabc5e33))

# [2.71.0](https://github.com/namhtpyn/tandem/compare/v2.70.0...v2.71.0) (2026-11-05)


### Bug Fixes

* [#322](https://github.com/namhtpyn/tandem/issues/322) r1 review — persist-ALL-then-enqueue (mid-relay redis failure can never drop a mapping; rows stay raw for the sweep), pair-aware maxLen cap (a split surrogate is an invalid JSON escape a homeserver rejects forever), deferral give-up releases the claim (ghost-claim head-gate stall), SPEC honesty: at-least-once delivery worded as the slice-1 law ([c11b631](https://github.com/namhtpyn/tandem/commit/c11b6314861663af5ec0e69f3ee14b0c236c0a3c))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r2 review — post-claim guard (config read/head query/processed write release the claim on throw; quick job retries can never no-op on a fresh claim and orphan the row), SPEC honesty: ambiguous-send retry clause + best-effort trigger window made explicit ([a9c9b6e](https://github.com/namhtpyn/tandem/commit/a9c9b6e41c440e519f4134a2ea718f106be7d136))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r3 review — CAS-loss re-kick (a killed worker can never orphan a claimed-jobless row: the loser re-kicks after the claim TTL, bounded), honest settle-failure log (pre-insert vs post-insert recovery), SPEC: row-vs-enqueue idempotence mechanism, restart-fresh deferral budget, mid-send kill recovery + poll churn stated ([8de57b7](https://github.com/namhtpyn/tandem/commit/8de57b7d3946af37a41ddc40bfd259413effb135))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r4 review — boot sweep ONCE PER PROCESS (the 30s partial-start retry loop re-sweeping reset the deferral budget forever and churned the queue while an adapter was down; stop/start re-sweeps), honest jobless + empty-body SPEC clauses, stale-claim CAS predicate modeled in tests (fresh refuses / stale steals = the mid-send-kill recovery path) ([5c6b303](https://github.com/namhtpyn/tandem/commit/5c6b3037e0910823677b9415cb94bfeb0d093d4c))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r5 review — SPEC honesty: restart parallel cycle chains stated (claim CAS arbitrates), pre-insert relay-loss window covers any preceding settle side-effect failure ([f698e16](https://github.com/namhtpyn/tandem/commit/f698e164bfe5b398021b1dcbc46d8704e447dcf6))
* [#323](https://github.com/namhtpyn/tandem/issues/323) release retry — transient commit_refs_rules rejection ate the v2.71.0 tag push (rerun served a stale main and silently skipped) ([7f37530](https://github.com/namhtpyn/tandem/commit/7f37530de90ef2cdd98a7d6628886c7587671458))


### Features

* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 2 — reply relay: channel_outbox persist-first per mapped thread, unique (adapter,runId,threadRef) idempotence, per-thread ordering (oldest-first head gate, capped wait polls), adapter-down deferral parity (no-loss), maxLen cap, boot sweep + outbound worker, best-effort DONE-run trigger in the settle path ([0d3eea2](https://github.com/namhtpyn/tandem/commit/0d3eea2440b7de64338d79da583e3a43f84b2848))
* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 2 spec — reply relay contract (final-only outbound, outbox-first durability, per-thread ordering, deferral parity) ([2fa68f8](https://github.com/namhtpyn/tandem/commit/2fa68f8d37a45f73dcb95d14827f00971ca5248d))

# [2.71.0](https://github.com/namhtpyn/tandem/compare/v2.70.0...v2.71.0) (2026-11-05)


### Bug Fixes

* [#322](https://github.com/namhtpyn/tandem/issues/322) r1 review — persist-ALL-then-enqueue (mid-relay redis failure can never drop a mapping; rows stay raw for the sweep), pair-aware maxLen cap (a split surrogate is an invalid JSON escape a homeserver rejects forever), deferral give-up releases the claim (ghost-claim head-gate stall), SPEC honesty: at-least-once delivery worded as the slice-1 law ([c11b631](https://github.com/namhtpyn/tandem/commit/c11b6314861663af5ec0e69f3ee14b0c236c0a3c))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r2 review — post-claim guard (config read/head query/processed write release the claim on throw; quick job retries can never no-op on a fresh claim and orphan the row), SPEC honesty: ambiguous-send retry clause + best-effort trigger window made explicit ([a9c9b6e](https://github.com/namhtpyn/tandem/commit/a9c9b6e41c440e519f4134a2ea718f106be7d136))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r3 review — CAS-loss re-kick (a killed worker can never orphan a claimed-jobless row: the loser re-kicks after the claim TTL, bounded), honest settle-failure log (pre-insert vs post-insert recovery), SPEC: row-vs-enqueue idempotence mechanism, restart-fresh deferral budget, mid-send kill recovery + poll churn stated ([8de57b7](https://github.com/namhtpyn/tandem/commit/8de57b7d3946af37a41ddc40bfd259413effb135))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r4 review — boot sweep ONCE PER PROCESS (the 30s partial-start retry loop re-sweeping reset the deferral budget forever and churned the queue while an adapter was down; stop/start re-sweeps), honest jobless + empty-body SPEC clauses, stale-claim CAS predicate modeled in tests (fresh refuses / stale steals = the mid-send-kill recovery path) ([5c6b303](https://github.com/namhtpyn/tandem/commit/5c6b3037e0910823677b9415cb94bfeb0d093d4c))
* [#322](https://github.com/namhtpyn/tandem/issues/322) r5 review — SPEC honesty: restart parallel cycle chains stated (claim CAS arbitrates), pre-insert relay-loss window covers any preceding settle side-effect failure ([f698e16](https://github.com/namhtpyn/tandem/commit/f698e164bfe5b398021b1dcbc46d8704e447dcf6))


### Features

* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 2 — reply relay: channel_outbox persist-first per mapped thread, unique (adapter,runId,threadRef) idempotence, per-thread ordering (oldest-first head gate, capped wait polls), adapter-down deferral parity (no-loss), maxLen cap, boot sweep + outbound worker, best-effort DONE-run trigger in the settle path ([0d3eea2](https://github.com/namhtpyn/tandem/commit/0d3eea2440b7de64338d79da583e3a43f84b2848))
* [#271](https://github.com/namhtpyn/tandem/issues/271) slice 2 spec — reply relay contract (final-only outbound, outbox-first durability, per-thread ordering, deferral parity) ([2fa68f8](https://github.com/namhtpyn/tandem/commit/2fa68f8d37a45f73dcb95d14827f00971ca5248d))

# [2.70.0](https://github.com/namhtpyn/tandem/compare/v2.69.0...v2.70.0) (2026-11-05)


### Bug Fixes

* [#320](https://github.com/namhtpyn/tandem/issues/320) r1 review — whoami echo guard on EVERY start (sync carries no user_id; first-boot ack loop), events persist their originating adapter key (no cross-config binding/ack wiring), stale-binding refusal (no FK poison retry), new-task mapping arbiter (loser cleans up + routes as note), composer 10k body caps, conflict-recovery re-enqueue, adapter registry (zero kind branches in core), SPEC updated (at-least-once wording, gappy-sync deferred) ([5cfcf71](https://github.com/namhtpyn/tandem/commit/5cfcf7144bcd5bbefaa98d8e0d99e8f3b5ff9752))
* [#320](https://github.com/namhtpyn/tandem/issues/320) r2 review — per-request AbortSignal timeouts (half-open sockets can't wedge the loop), jobId per event (deploy-overlap double-route closed), adapters start BEFORE the boot sweep (swept acks land), uuid-typed binding ids (no 22P02 poison), blank-only messages refused (no empty-title tasks), m.replace edits filtered inbound, M_UNKNOWN_POS checkpoint reset, duplicate adapter configs refused, start() throws on failed whoami/init (dead adapters never register), SPEC updated ([aedcf08](https://github.com/namhtpyn/tandem/commit/aedcf08056946014b14120150f7b47becc1a4509))
* [#320](https://github.com/namhtpyn/tandem/issues/320) r3 review — PROD-CRITICAL: explicit registry arming (side-effect import was tree-shaken out of the Nitro bundle → zero adapters in prod), jobId=event-id (BullMQ rejects ':' 2-segment ids), removeOnFail frees failed-job ids for sweep re-drive; deferral law (no config / no live adapter ⇒ event stays queued, never consumed); blank messages refused on every verb; thread mappings keyed by originating adapter (channel_threads.adapter, migration regen); homeserver URL canonicalization before dedupe; ack only claims dispatch for ready-category AI assignees; send retries 429/5xx + JSON content-type; worker registers after adapters; SPEC updated ([acc02de](https://github.com/namhtpyn/tandem/commit/acc02de0d369a1a6d44ca7cb5edcc4d4393a67a7))
* [#320](https://github.com/namhtpyn/tandem/issues/320) r4 review — employee-tier role gate on bindings (VIEWER refused like the oRPC kernel), deferral re-drives every 5min bounded 12x (no restart needed, row never consumed), isLive() on the adapter contract (dead tokens defer instead of routing into the void), NUL-byte sanitization on persist (one NUL can never wedge a channel), event dedupe keyed (adapter, external_id), status pick = first READY category, channels under settings integrity audit, boot-start retry loop (ensureChannelsRunning), txn-id reuse across send retries, SPEC honesty on per-kind config (one adapter file + one arming line) ([e1590ff](https://github.com/namhtpyn/tandem/commit/e1590ffcc496d08e20160b989e0d9c72160de0df))
* [#320](https://github.com/namhtpyn/tandem/issues/320) r5 review — claimed_at CAS (exactly one worker per event; deferral cycles/sweep/deploy-overlap can never double-route; stale claim re-claimable 5min = at-least-once kept), partial-start law (ensureChannelsRunning keeps retrying while adapters failed; dead adapters stopped + re-armed), composer-parity status pick (first by position, tasks.create default), arbiter loser deletes only message-free tasks, answer-replay honesty ack, boot sweep partial index ([9065cd7](https://github.com/namhtpyn/tandem/commit/9065cd7e2ef68d23dd09c1e9554fbc233161254c))
* [#320](https://github.com/namhtpyn/tandem/issues/320) r6 review — lone-surrogate sanitization (pair-aware; one crafted message can never wedge a channel), missing-secret/missing-factory count toward failed[] (partial-start loop keeps firing), CAS-lost answer preserves the text as a note with an honest ack ([162f045](https://github.com/namhtpyn/tandem/commit/162f04517ddc753e6ee56fa74a340184d923698b))


### Features

* [#271](https://github.com/namhtpyn/tandem/issues/271) channels slice 1 — contract-v1 core + matrix adapter (persist→checkpoint→BullMQ→sweep durability, default-deny bindings, composer-proc routing verbs, instant acks, whoami echo guard) ([d596bd6](https://github.com/namhtpyn/tandem/commit/d596bd6ad2672c7ba51dd12bb90b0ae022bcf456))

# [2.69.0](https://github.com/namhtpyn/tandem/compare/v2.68.1...v2.69.0) (2026-11-05)


### Bug Fixes

* [#270](https://github.com/namhtpyn/tandem/issues/270) slice 3 review pass — authKind 'none' echo is not oauth config (stdio refusal narrowed to endpoint keys); run-fold assert law ([cca1551](https://github.com/namhtpyn/tandem/commit/cca1551199c3894fb51da40b1bfb716059ba565c))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r1 review — oauth switch refusal keys off persisted row (echo-proof), total-cap probe deadline, SIGKILL escalation, args one-per-line round-trip, binding-manager transport badge, SPEC env-var charset ([abdc84f](https://github.com/namhtpyn/tandem/commit/abdc84f16de1f46003e820a1f7cb590d9c03605e))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r2 review — bindingsListByServer carries transport, banner-blind extractJsonRpc, capped stderr drain, args charset guard, stdio→http column nulling (SPEC contract updated) ([8a918d4](https://github.com/namhtpyn/tandem/commit/8a918d40d4756fb08455af0eabae61e81c353437))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r3 review — args charset guard rejects lone CR (single-line contract holds) ([1fe1159](https://github.com/namhtpyn/tandem/commit/1fe1159b2b55358798361d9333705c669449b23a))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r4 review — corrupt-args read surfaces degrade per-row (list → [], probe verdict persists, dispatch skips), streaming TextDecoder, stdio probe path skips the unused Authorization decrypt ([56f5df2](https://github.com/namhtpyn/tandem/commit/56f5df2712445487b83d13a70c57fdcda1230f62))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r5 review — probe verdicts REDACTED before persistence (credential echo can't reach last_probe_detail), bindingsListByServer table row documents the full shape, transport switch resets stale auth UI state (SPEC updated) ([16f3281](https://github.com/namhtpyn/tandem/commit/16f32813968617e98c44cea279f197a57cef372e))
* [#318](https://github.com/namhtpyn/tandem/issues/318) r6 review — pre-stdio auth snapshot RESTORED on http return (no silent oauth strip), handshake answers require jsonrpc+id echo, corrupt command/url rows degrade per-row (probe verdict persists, dispatch skips), stdio member drops the extra discriminator (SDK 2.1.0 schema truth, SPEC updated) ([511e44f](https://github.com/namhtpyn/tandem/commit/511e44f7f01e21d794d13425552fd1fa9982a795))


### Features

* [#270](https://github.com/namhtpyn/tandem/issues/270) slice 3 migration — mcp_servers transport/command/args/credential_env_var, url nullable (drizzle-kit generated) ([f25620f](https://github.com/namhtpyn/tandem/commit/f25620f3a6f3e25cf6a510acacc9d60bff8ba27c))
* [#270](https://github.com/namhtpyn/tandem/issues/270) slice 3 stdio transport — dispatch member, spawn probe, registry UI (transport/command/args/credentialEnvVar, oauth∩stdio refused) ([ec928ec](https://github.com/namhtpyn/tandem/commit/ec928ec0075d387b416b3f6087189bca72b0233d))

## [2.68.1](https://github.com/namhtpyn/tandem/compare/v2.68.0...v2.68.1) (2026-11-04)


### Bug Fixes

* [#314](https://github.com/namhtpyn/tandem/issues/314) r1 review — obligation cancel moved AFTER the won flip; heal reviewed out (shared-state guard law) ([e91dac9](https://github.com/namhtpyn/tandem/commit/e91dac9e7a925e369df913aea7e708de6ff84a58))
* [#314](https://github.com/namhtpyn/tandem/issues/314) tasks.note never flips/dispatches a waiting_answer task; answerQuestion heals a CAS-miss strand ([ada44fa](https://github.com/namhtpyn/tandem/commit/ada44fa2210d1d095f0d5c87b42f4af2e0113635))

# [2.68.0](https://github.com/namhtpyn/tandem/compare/v2.67.8...v2.68.0) (2026-11-04)


### Bug Fixes

* [#274](https://github.com/namhtpyn/tandem/issues/274) coverage — component tests pin every useMcpOauthConnect arm (blocked popup, mint failure, callback, dead-popup watcher, mint success) + v8-ignore the merge-phantom spans ([2ca36b1](https://github.com/namhtpyn/tandem/commit/2ca36b181048d8c34777f276b4aac564eccac59a))
* [#274](https://github.com/namhtpyn/tandem/issues/274) review r1 — surface failed bindings reads (banner+retry, empty state hidden), oauth rows drop the dead credential picker, unbind rides the editor-parity two-step confirm ([a2a4339](https://github.com/namhtpyn/tandem/commit/a2a43393a9b24c8370bb4c54ab653d1cda3bf380))
* [#274](https://github.com/namhtpyn/tandem/issues/274) review r2 — editor bindings join the MCP query cache (SPEC sync lives both ways), shared useMcpOauthConnect + Connect/Reconnect on /mcp oauth rows, clear-credential confirm, bind form gated on failed reads + live-sync e2e pin ([fe2419e](https://github.com/namhtpyn/tandem/commit/fe2419e6cac1898d2263739cfe33f3a205c3d34e))
* [#274](https://github.com/namhtpyn/tandem/issues/274) review r3 — oauth callback publishes the change bus (SPEC sync), editor/modal pending+failed reads never render authoritative empty states, modal reopen resets armed confirms + stale connect banner, CHANGE_RESOURCE enum replaces hand-copied literals, stale pages-table SPEC row fixed ([7e870ee](https://github.com/namhtpyn/tandem/commit/7e870eef7a6669d0533c193fb6a6bb66dbab5728))
* [#274](https://github.com/namhtpyn/tandem/issues/274) review r4 — editor open-reset parity (armed confirm/stale banners cleared, no-immediate TDZ guard), per-row connect spinner via employee:server key, employees-picker failure surfaces + gates the bind form, SPEC complete-list table gains bindingsListByServer ([25fa31e](https://github.com/namhtpyn/tandem/commit/25fa31ee9c0916b4740028ebe8d54b56af1541ae))


### Features

* [#274](https://github.com/namhtpyn/tandem/issues/274) /mcp per-server binding manager — bind/unbind agents + credential from the registry row (mcp.bindingsListByServer) ([25ea11b](https://github.com/namhtpyn/tandem/commit/25ea11b990941f8c1cbf251d60a15b9d1d84d1f9))

## [2.67.8](https://github.com/namhtpyn/tandem/compare/v2.67.7...v2.67.8) (2026-11-04)


### Bug Fixes

* [#278](https://github.com/namhtpyn/tandem/issues/278) MCP OAuth connect mint behind admin oRPC POST — CSRF-intent binding (delete state-changing GET route) ([abe90f4](https://github.com/namhtpyn/tandem/commit/abe90f4b89dd592a7a7294b3c1aedf6316827bf5))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r1 — complete SPEC diffs (3 stale GET-route sections), surface mint failures in the editor, skip the mint when the popup is blocked ([6fc4f15](https://github.com/namhtpyn/tandem/commit/6fc4f159f9d69829fcdb44c3514f6ecc3af55ff5))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r2 — pin the {connectUrl,serverName} mint shape in e2e, surface popup-blocked feedback ([707bb88](https://github.com/namhtpyn/tandem/commit/707bb8826f2450319a1e61a85391bb3df981a11c))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r3 — SPEC mint-exempt change-bus carve + admin enumeration, pin RPC-GET 404 + BAD_REQUEST mapping, clear stale connect error on retry ([0e556c2](https://github.com/namhtpyn/tandem/commit/0e556c22a3a1535ba4903008354d82a2f28cd662))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r4 — enumerate mcp.oauthConnect in the SPEC MCP-procedures table ([65cbd2c](https://github.com/namhtpyn/tandem/commit/65cbd2c5cf76d52e28689e7f1a8699a3af08a856))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r5 — pin the wrong-role leg of the mint gate (seeded VIEWER session -> 403) ([1947276](https://github.com/namhtpyn/tandem/commit/19472760205221ed011816fa660cd81719341384))
* [#278](https://github.com/namhtpyn/tandem/issues/278) review r6 — pin the anon mint status exactly 401 (UNAUTHORIZED precedes the role check) ([ceea204](https://github.com/namhtpyn/tandem/commit/ceea204fbe0089eb7b989dcacc09501f99605fc9))

## [2.67.7](https://github.com/namhtpyn/tandem/compare/v2.67.6...v2.67.7) (2026-11-04)


### Bug Fixes

* [#300](https://github.com/namhtpyn/tandem/issues/300) blind-review r1 — gate the task detail page, kebab order/divider, SPEC + test honesty ([96b7804](https://github.com/namhtpyn/tandem/commit/96b7804b59a9659b21efedcf0b00c7e040e803b6)), closes [#210](https://github.com/namhtpyn/tandem/issues/210)
* [#300](https://github.com/namhtpyn/tandem/issues/300) blind-review r2 — restore Delete hover class, label-law fallbacks, Add-subtask pins ([4882cab](https://github.com/namhtpyn/tandem/commit/4882cab128e71a89bc6363724f398654d48f2f49))
* [#300](https://github.com/namhtpyn/tandem/issues/300) viewer sees employee-tier write verbs — useCanWork hides tasks/projects write UI below the employee tier ([f98e7ca](https://github.com/namhtpyn/tandem/commit/f98e7ca55ea41e6c0826ba37c86c41b1ccb4584f))

## [2.67.6](https://github.com/namhtpyn/tandem/compare/v2.67.5...v2.67.6) (2026-11-04)


### Bug Fixes

* [#291](https://github.com/namhtpyn/tandem/issues/291) lifecycle hygiene — stop-marker pre-try leak, per-tick worker-resync retry, refresh-warn eviction ([c6ba999](https://github.com/namhtpyn/tandem/commit/c6ba999bcac9edf47a0be378ff3fc84a650a8dc7))
* [#291](https://github.com/namhtpyn/tandem/issues/291) review rounds — pre-try-window marker cleanup, unique-id marker tests, full refresh-warn eviction coverage ([e02c47e](https://github.com/namhtpyn/tandem/commit/e02c47eb34d652e84a9e4e83a3d8e16fabbdf116))

## [2.67.5](https://github.com/namhtpyn/tandem/compare/v2.67.4...v2.67.5) (2026-11-04)


### Bug Fixes

* [#263](https://github.com/namhtpyn/tandem/issues/263) r2 review — the vault folder filter hides behind editable too (dead select on a FORBIDDEN read) ([2e647b2](https://github.com/namhtpyn/tandem/commit/2e647b2ee97a9bfd489e6f1cab4ccc7d2891a7bc))
* [#263](https://github.com/namhtpyn/tandem/issues/263) wire the UI tier visibility gates — nav/settings/admin managers render no verb above the viewer's role ([03be5bd](https://github.com/namhtpyn/tandem/commit/03be5bd9939ca321570ce4490ffc425787d22b4e))

## [2.67.4](https://github.com/namhtpyn/tandem/compare/v2.67.3...v2.67.4) (2026-11-04)


### Bug Fixes

* [#264](https://github.com/namhtpyn/tandem/issues/264) [#265](https://github.com/namhtpyn/tandem/issues/265) — UI honors the specced server contract on every task surface ([4076afa](https://github.com/namhtpyn/tandem/commit/4076afa01795af2383585ffdc9e922595f50f290))
* [#264](https://github.com/namhtpyn/tandem/issues/264) [#265](https://github.com/namhtpyn/tandem/issues/265) r2 blind-review round 2 — the lock releases on every settle; the hint never promises past the verb ([5f5db23](https://github.com/namhtpyn/tandem/commit/5f5db2391ac06f021b6014cb1fa25425ebb3c39d))
* [#264](https://github.com/namhtpyn/tandem/issues/264) [#265](https://github.com/namhtpyn/tandem/issues/265) r3 blind-review round 3 — verb routing is category-only; the hold is race-free ([ade4da9](https://github.com/namhtpyn/tandem/commit/ade4da9d28f64ad3c09abb0d8208a495d6b7dc8e))
* [#264](https://github.com/namhtpyn/tandem/issues/264) [#265](https://github.com/namhtpyn/tandem/issues/265) r4 blind-review round 4 — the hint never promises past the queue ([549cf2f](https://github.com/namhtpyn/tandem/commit/549cf2fd928c50f4e7fb9f7bc6f1c267f8531df6)), closes [#288](https://github.com/namhtpyn/tandem/issues/288)
* [#264](https://github.com/namhtpyn/tandem/issues/264) [#265](https://github.com/namhtpyn/tandem/issues/265) r5 blind-review round 5 — the wording never claims an outcome the server withheld ([466bb39](https://github.com/namhtpyn/tandem/commit/466bb3990a73b4606c3b0adace8b3c4eaa701b80))
* [#264](https://github.com/namhtpyn/tandem/issues/264) e2e — hold the dispatcher scan off manually-dispatched specs (run-stop CI failure was the 5s tick claiming the fresh ready task mid-test; manual verb ignores dispatch_after, only the scan respects it); tasks.spec send click rides the visible label (the accessible name now carries the hint wording) ([4b058eb](https://github.com/namhtpyn/tandem/commit/4b058eb9f42253681e526c5cdbc6e4ddce2628c3))
* [#264](https://github.com/namhtpyn/tandem/issues/264) r1 blind-review round 1 — the lock reaches every assignee writer ([7f5bd44](https://github.com/namhtpyn/tandem/commit/7f5bd44a903e29ab9e8e434ce17a1afdc42cd381)), closes [#265](https://github.com/namhtpyn/tandem/issues/265)

## [2.67.3](https://github.com/namhtpyn/tandem/compare/v2.67.2...v2.67.3) (2026-11-03)


### Bug Fixes

* [#284](https://github.com/namhtpyn/tandem/issues/284) [#285](https://github.com/namhtpyn/tandem/issues/285) acp setup-kill — dead-wire catch rides from creation, teardown live from stream registration, every setup await races the dead-wire promise ([969e000](https://github.com/namhtpyn/tandem/commit/969e000cf0880ef9ece4d7c612a11a9d10255420))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r1 blind-review round 1 — in-window rescue (answer landing between the hold's status read and the revert: guarded ready->in_review restore + held-reviewer re-fire), APPROVAL obligation re-spawn on hold (human reviewers keep their decision surface), [#290](https://github.com/namhtpyn/tandem/issues/290) resyncAfter intent chaining (settings/roster change applies immediately, not next trigger); [#288](https://github.com/namhtpyn/tandem/issues/288) SPEC wording scoped to the seeded answer verb + owner unblock ([615809a](https://github.com/namhtpyn/tandem/commit/615809afb93927f36cd509c906e96bcbe2ac7376))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r2 blind-review round 2 — an owner settle winning the hold window heals (supersede the just-reverted row + cancel APPROVAL obligations; spawn waits for the post-revert status read so no decision surface outlives a settled task), every rescue arm publishes the change event, a lost restore flip notes the thread; SPEC r2 amendment ([4382b55](https://github.com/namhtpyn/tandem/commit/4382b555349f663b5d281374349a8ad14882b012))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r3 blind-review round 3 — spawn precedes the heal's status re-read (either settle ordering self-heals: settle-after-revert finds the row PENDING at its own teardown, settle-before-it hits the heal whose cancel removes anything the spawn inserted), vanished-task guard heals like the sibling escalation path, in_review rescue arm dropped (never a second dispatch source — the flip's writer re-fires), heal publishes; SPEC r3 amendment ([a3cfeac](https://github.com/namhtpyn/tandem/commit/a3cfeac1fa1f126e3e23c2f456c41a0b6b20c447))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r4 blind-review round 4 — working/other non-terminal mid-window landings note the thread (the RUN LOCK blocks the owner unblock while a run is live; the note is the only signal until it settles), SPEC rescue trigger scoped to the observed ready-category landing ([87ca0c7](https://github.com/namhtpyn/tandem/commit/87ca0c713e76b6321b70c981402662248ae09244))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r5 blind-review round 5 — the in_review landing re-fires from the hold itself (the flip writer's own re-fire can predate the revert and mint nothing; the hold's re-fire runs post-revert where the held row is PENDING — the live-turn check bounds duplication, the verdict CAS arbitrates), answerQuestion re-checks round liveness post-flip and repairs a hold-revert it raced (ONE guarded ready->in_review flip + re-fire); SPEC r5 amendments ([4ab6b4e](https://github.com/namhtpyn/tandem/commit/4ab6b4e3cf1681c4506342bf20d54ddf04d3578a))
* [#288](https://github.com/namhtpyn/tandem/issues/288) r6 blind-review round 6 (cap) — the answer-side repair flip-lost arm notes the thread (never a silent strand), SPEC hold contract scoped honestly to the round-closing verdict (non-closing verdicts stay decided under the normal waiting machinery) ([7a8423a](https://github.com/namhtpyn/tandem/commit/7a8423a2c3a84220d80fd9752ab8b4d7e25be8ce))
* [#288](https://github.com/namhtpyn/tandem/issues/288) verdict settles from waiting_answer hold the round — settling row reverts to PENDING, flip gate refuses waiting_answer categories, refused flips re-check and park ([06590df](https://github.com/namhtpyn/tandem/commit/06590dffda93a7737be06990c703735d0ec00bfa))
* [#289](https://github.com/namhtpyn/tandem/issues/289) boot change-fanout bridge retries bounded 5x2s then logs loudly and continues — a redis blip never aborts boot ([5ebaae7](https://github.com/namhtpyn/tandem/commit/5ebaae791944d4c7175abb55e58fa016bf718798))
* [#290](https://github.com/namhtpyn/tandem/issues/290) syncDispatchWorkers coalesces concurrent invocations — one in-flight execution per process, roster re-check stays authoritative ([4922188](https://github.com/namhtpyn/tandem/commit/4922188c91bfcebabbdffaf87dbd34f6ad08255e))

## [2.67.2](https://github.com/namhtpyn/tandem/compare/v2.67.1...v2.67.2) (2026-11-03)


### Bug Fixes

* [#282](https://github.com/namhtpyn/tandem/issues/282) [#283](https://github.com/namhtpyn/tandem/issues/283) [#286](https://github.com/namhtpyn/tandem/issues/286) [#287](https://github.com/namhtpyn/tandem/issues/287) guarded lifecycle writes — round-open failure surfaces instead of stranding, escalate verdict-row CAS, writer.finish settles once (0-row arbiter skips side effects), abandon arbitrates on the read status ([11d5db6](https://github.com/namhtpyn/tandem/commit/11d5db67ed7b9463c3ec9101ed82a37e1b160153))
* [#292](https://github.com/namhtpyn/tandem/issues/292) r1 — blind-review round 1 findings: submit/answer flips arbitrate on the read status (lost submit tears its round down), escalate mints nothing when the task settles mid-flight, review-dispatch enqueue failures never bounce the work task, round-open rethrow scoped to the working window ([d148d87](https://github.com/namhtpyn/tandem/commit/d148d87155b724853382f5c31b7dab83d14a0ff4))
* [#292](https://github.com/namhtpyn/tandem/issues/292) r2 — blind-review round 2 findings: escalate mint self-heals a settle landing inside the window (teardown + roster revert), lifecycle flips arbitrate on status AND updatedAt stamp (ABA-proof), lost submit disarms a park ladder landed mid-window ([1d10706](https://github.com/namhtpyn/tandem/commit/1d107067748a863d636f3fd71c90aaadb21cbbcf))
* [#292](https://github.com/namhtpyn/tandem/issues/292) r3 — blind-review round 3: drop the lost-submit park-disarm (it could only ever strip a concurrent round's legitimate park recovery), gate the escalate self-heal on terminal category (a parked-but-live round is never healed); r3 P1 finding rejected with logged evidence (mint loop sits outside the r1 try/catch — duplicate submits throw the unique violation in the loop, never reaching the teardown) ([00aa5a3](https://github.com/namhtpyn/tandem/commit/00aa5a3a055c02175691aa6cd7902148566ba2d4))

## [2.67.1](https://github.com/namhtpyn/tandem/compare/v2.67.0...v2.67.1) (2026-11-03)


### Bug Fixes

* [#276](https://github.com/namhtpyn/tandem/issues/276) settle-path doc cleanup — drop dangling end-of-round comment above the status helper ([58c624a](https://github.com/namhtpyn/tandem/commit/58c624aeaaf8ee12311129c876fe8c814cd75c2a))

# [2.67.0](https://github.com/namhtpyn/tandem/compare/v2.66.0...v2.67.0) (2026-11-03)


### Bug Fixes

* **mcp:** blind-review round 1 — value-diff oauth wipe (no-op saves keep tokens), client-secret vault guard, state-row wipe + callback kind re-check, revoke both tokens, guarded decrypt, popup-close recovery, employee-cascade revocation, masked hasClientSecret ([ce2921a](https://github.com/namhtpyn/tandem/commit/ce2921a8aae690cc1ffa5d05337e533716d14708))
* **mcp:** blind-review round 2 — refresh-first revocation (independent per-token POSTs), refresh grant without access decrypt, rate-limited refresh-failure trace, expired-state TTL sweep, config fingerprint bound into state + verified at callback, transactional registry update, always-visible reconnect verb, SPEC table/trigger alignment ([ad1f2e7](https://github.com/namhtpyn/tandem/commit/ad1f2e75ab763af62c000f1f265f454efc7419a2))
* **mcp:** blind-review round 3 — required oauth trio rejects explicit null (400) instead of silently keeping the old value; SPEC: config_fingerprint in schema line, OAuth REST pair in Routes table + API-law exceptions ([72d369a](https://github.com/namhtpyn/tandem/commit/72d369a0e299dd570f1cdac23523622d763a8ec6))
* **mcp:** blind-review round 4 — authorizeUrl joins the config fingerprint; post-exchange fingerprint re-check prevents old-contract token resurrection ([597fb73](https://github.com/namhtpyn/tandem/commit/597fb73372bebf43114964d6e08a3d01c2f5a4c3))
* **mcp:** blind-review round 5 — token rows carry the config fingerprint (inert-and-deleted on read), refresh persistence UPDATE-only, vault client-secret rotation wipes tokens/states/verdicts, revocationUrl null clears ([f10e831](https://github.com/namhtpyn/tandem/commit/f10e83134cb92bed20cb2f3afe563a03b9853902))
* **mcp:** blind-review round 6 — masked status read obeys the inert-row law (stale-fingerprint rows report not-connected and are deleted on the read) ([b416a0b](https://github.com/namhtpyn/tandem/commit/b416a0b67a8c06786ed0b297fd9f7d878d23197d))


### Features

* **mcp:** OAuth per binding — registry auth kinds, PKCE connect/callback, silent refresh at dispatch, revoke on unbind ([#270](https://github.com/namhtpyn/tandem/issues/270) slice 2) ([f49550c](https://github.com/namhtpyn/tandem/commit/f49550cb988f416f68b8fdcc8175c7424b8bbabb))

# [2.66.0](https://github.com/namhtpyn/tandem/compare/v2.65.11...v2.66.0) (2026-11-03)


### Bug Fixes

* **e2e:** mcp revoke assert reads per-fold raw output; return to task page before turn asserts ([8c2471c](https://github.com/namhtpyn/tandem/commit/8c2471c5ffbfc14bfd76be9d8c478c176b6d673e))


### Features

* **mcp:** registry + per-agent bindings + ACP dispatch injection ([#270](https://github.com/namhtpyn/tandem/issues/270) slice 1) ([1df9fd4](https://github.com/namhtpyn/tandem/commit/1df9fd41114dc049c80c6a8c4f433dfbb024ab6d))
* **spec:** MCP registry + per-agent bindings contract ([#270](https://github.com/namhtpyn/tandem/issues/270) slice 1) ([f51bbfe](https://github.com/namhtpyn/tandem/commit/f51bbfebfa3d84dc4b58cd21818733ae651269b1))
* **ui:** MCP registry page + agent-editor binding/probe section ([#270](https://github.com/namhtpyn/tandem/issues/270) slice 1) ([038583d](https://github.com/namhtpyn/tandem/commit/038583d60725637b8be9e6c58b326ae3d9bea6ce))

## [2.65.11](https://github.com/namhtpyn/tandem/compare/v2.65.10...v2.65.11) (2026-11-03)


### Bug Fixes

* **acp:** catch session/cancel rejections + guard post-close writes on the ssh stream ([#262](https://github.com/namhtpyn/tandem/issues/262)) ([37ab80f](https://github.com/namhtpyn/tandem/commit/37ab80f011581561c45adab82fae556a2cdb6301))

## [2.65.10](https://github.com/namhtpyn/tandem/compare/v2.65.9...v2.65.10) (2026-11-03)


### Bug Fixes

* **review:** verdict-row CAS + guarded end-of-round flips — a late verdict can no longer override a manual settle ([#260](https://github.com/namhtpyn/tandem/issues/260)) ([89d9e8a](https://github.com/namhtpyn/tandem/commit/89d9e8afc0d6b26168c6103efe5b37bb3f467045))

## [2.65.9](https://github.com/namhtpyn/tandem/compare/v2.65.8...v2.65.9) (2026-11-02)


### Performance Improvements

* **runs:** gate streaming RUNS publishes behind a 3s heartbeat — transcript no longer ships per 500ms flush (audit [#253](https://github.com/namhtpyn/tandem/issues/253)) ([f9a078d](https://github.com/namhtpyn/tandem/commit/f9a078d916448ee2ab109824ae2d4c15aa68e535))

## [2.65.8](https://github.com/namhtpyn/tandem/compare/v2.65.7...v2.65.8) (2026-11-02)


### Bug Fixes

* **rpc:** pre-read body-cap gate on /rpc — 411 chunked, 413 over 2MB input (audit [#252](https://github.com/namhtpyn/tandem/issues/252)) ([d2483d0](https://github.com/namhtpyn/tandem/commit/d2483d0dea22f2e193207ed1bbc5ff7f34751492)), closes [#241](https://github.com/namhtpyn/tandem/issues/241)

## [2.65.7](https://github.com/namhtpyn/tandem/compare/v2.65.6...v2.65.7) (2026-11-02)


### Bug Fixes

* **auth:** gate auth policy checks on the router-normalized pathname (audit [#251](https://github.com/namhtpyn/tandem/issues/251)) ([cc6f3fe](https://github.com/namhtpyn/tandem/commit/cc6f3fe045cc500c9a8f146caf12baf1f3174811))

## [2.65.6](https://github.com/namhtpyn/tandem/compare/v2.65.5...v2.65.6) (2026-11-02)


### Bug Fixes

* **test:** pin BETTER_AUTH_URL in e2e webserver env — better-auth origin warn spammed every run ([02aeff9](https://github.com/namhtpyn/tandem/commit/02aeff9d90a3926eff0b22758deff1a5fd246f0b))

## [2.65.5](https://github.com/namhtpyn/tandem/compare/v2.65.4...v2.65.5) (2026-11-02)


### Bug Fixes

* **auth:** rotation lock enforced on REST file reads — attachment/avatar GETs 403 while locked (audit [#242](https://github.com/namhtpyn/tandem/issues/242)) ([82c1afc](https://github.com/namhtpyn/tandem/commit/82c1afc403004b2b7a6a524de0faca8b478016a9))

## [2.65.4](https://github.com/namhtpyn/tandem/compare/v2.65.3...v2.65.4) (2026-11-02)


### Bug Fixes

* **auth:** refuse undeclared chunked request bodies pre-read — 411 on /auth/** + attachment upload (audit [#241](https://github.com/namhtpyn/tandem/issues/241)) ([23acd04](https://github.com/namhtpyn/tandem/commit/23acd04e2ec7219a851e07c8b4d872a16a3e0d0e))

## [2.65.3](https://github.com/namhtpyn/tandem/compare/v2.65.2...v2.65.3) (2026-11-02)


### Bug Fixes

* **dispatcher:** redis outage self-heals — unlimited capped reconnect + redis-ok watchdog stamp ([#238](https://github.com/namhtpyn/tandem/issues/238)) ([2ace105](https://github.com/namhtpyn/tandem/commit/2ace105d33748abb3ebd33c41c02b22e813d67cb)), closes [#147](https://github.com/namhtpyn/tandem/issues/147)

## [2.65.2](https://github.com/namhtpyn/tandem/compare/v2.65.1...v2.65.2) (2026-11-02)


### Performance Improvements

* drop dead cache domain + 3 orphaned prod deps ([#226](https://github.com/namhtpyn/tandem/issues/226)) ([da5950b](https://github.com/namhtpyn/tandem/commit/da5950be93b95ce02f4b2d6ac8a2238d31b9cebc))

## [2.65.1](https://github.com/namhtpyn/tandem/compare/v2.65.0...v2.65.1) (2026-11-02)


### Bug Fixes

* **dispatcher:** liveness sweep read bounded to ONE LATERAL statement ([#225](https://github.com/namhtpyn/tandem/issues/225)) ([1a85e0c](https://github.com/namhtpyn/tandem/commit/1a85e0c6b635f4edbda9722ddc17f93c6d6d2be3))

# [2.65.0](https://github.com/namhtpyn/tandem/compare/v2.64.2...v2.65.0) (2026-11-02)


### Features

* **tasks:** stop-run verb — human stop for a live run ([#229](https://github.com/namhtpyn/tandem/issues/229)) ([bd07bdc](https://github.com/namhtpyn/tandem/commit/bd07bdc8c45d18bc0b9c88d1a6cfc35a1f1b5285))

## [2.64.2](https://github.com/namhtpyn/tandem/compare/v2.64.1...v2.64.2) (2026-11-02)


### Bug Fixes

* **kernel:** live streams re-assert the caller tier with a fresh session ([#224](https://github.com/namhtpyn/tandem/issues/224)) ([c8362d9](https://github.com/namhtpyn/tandem/commit/c8362d9d0d2b9dc0987ace7802cde57f35034140))

## [2.64.1](https://github.com/namhtpyn/tandem/compare/v2.64.0...v2.64.1) (2026-11-02)


### Bug Fixes

* **tasks:** cancel verb obeys the run lock on every surface ([#223](https://github.com/namhtpyn/tandem/issues/223)) ([fb10e78](https://github.com/namhtpyn/tandem/commit/fb10e78204fbb25102db5bcdbca3734826b804be))

# [2.64.0](https://github.com/namhtpyn/tandem/compare/v2.63.0...v2.64.0) (2026-11-02)


### Features

* **tasks:** single-task surfaces read tasks.get — page, editor parent, drawer fallback ([#220](https://github.com/namhtpyn/tandem/issues/220)) ([1f2a2a4](https://github.com/namhtpyn/tandem/commit/1f2a2a4b03d72f04de4ed713b1f9f51b9117a752))
* **tasks:** tasks.get by-id proc + tasks_created_id_idx ([#220](https://github.com/namhtpyn/tandem/issues/220)) ([ca4b287](https://github.com/namhtpyn/tandem/commit/ca4b28798fd5bacd9abde877eb651800d0fecd81))

# [2.63.0](https://github.com/namhtpyn/tandem/compare/v2.62.7...v2.63.0) (2026-11-02)


### Features

* **db:** park_rearm_attempts + park_rearm_after + partial index for the [#211](https://github.com/namhtpyn/tandem/issues/211) re-arm ladder ([b3e5031](https://github.com/namhtpyn/tandem/commit/b3e50314220a3b05ee9d645601b37d3683da1a4a))
* **park:** PARK-REARM LAW ([#211](https://github.com/namhtpyn/tandem/issues/211)) — infra-class review parks re-arm on a bounded ladder via a tick scan; decision parks never re-arm ([9e5148c](https://github.com/namhtpyn/tandem/commit/9e5148c1905d1135e3a67176c1e9beb3512e3059))

## [2.62.7](https://github.com/namhtpyn/tandem/compare/v2.62.6...v2.62.7) (2026-11-02)


### Bug Fixes

* **tasks:** toolbar New task renders on every view state — the empty board keeps a one-step create entry ([#210](https://github.com/namhtpyn/tandem/issues/210)) ([ed56068](https://github.com/namhtpyn/tandem/commit/ed560681284c967d8a14e69c8b5b15f9cd8d43b2))

## [2.62.6](https://github.com/namhtpyn/tandem/compare/v2.62.5...v2.62.6) (2026-11-02)


### Bug Fixes

* **tasks:** drawer Dispatch now obeys the shared server-truth gate — render parity with the task page ([#209](https://github.com/namhtpyn/tandem/issues/209)) ([d0b52d1](https://github.com/namhtpyn/tandem/commit/d0b52d195ce17c72c45cb3539530344ffe8b7e6a))

## [2.62.5](https://github.com/namhtpyn/tandem/compare/v2.62.4...v2.62.5) (2026-11-02)


### Bug Fixes

* **tasks:** guarded gating writes — unblock restore atomic on still-BLOCKED, auto-block on not-yet-BLOCKED; a lost race owns nothing and stops the walk ([#208](https://github.com/namhtpyn/tandem/issues/208)) ([9e250a1](https://github.com/namhtpyn/tandem/commit/9e250a1feb245cfc7aed781944e3f6a49c69ed90))

## [2.62.4](https://github.com/namhtpyn/tandem/compare/v2.62.3...v2.62.4) (2026-11-02)


### Bug Fixes

* **tasks:** manual-settle teardown is category-resolved — custom terminal statuses settle and ANSWER obligations die with waiting_answer leaves ([#205](https://github.com/namhtpyn/tandem/issues/205)) ([4894d91](https://github.com/namhtpyn/tandem/commit/4894d915ea54a560593ce7528923cc73b5daa603))

## [2.62.3](https://github.com/namhtpyn/tandem/compare/v2.62.2...v2.62.3) (2026-11-02)


### Bug Fixes

* **reviews:** park-origin memory — review parks restore to in-review when the parent gate lifts ([#202](https://github.com/namhtpyn/tandem/issues/202)) ([cd6c214](https://github.com/namhtpyn/tandem/commit/cd6c214a149a738c2f00fa0672915bb92cfdb7be))

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
