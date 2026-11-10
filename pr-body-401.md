## What

Closes #401. Two gaps let the review machine override the owner's manual move:

1. **The end-of-round flip refused only done/cancelled-category statuses.** A task the owner re-queued to `todo` (or parked) mid-round was still flipped to `done` by an all-approved settle — the machine overrode the owner's move.
2. **The review-turn mint had no category read.** `dispatchAiReviewTurns` could mint a run for a task a manual move (or a park) took out of review between the caller's reads and the run insert.

## Fix

- `flipTask` is now an **allow-list**: the write requires the task to still sit in an in-review-category status (ids resolved fresh from `task_statuses`, custom in-review statuses included). Terminal, waiting_answer and a plain re-queue/block all refuse; the verdict row stays as audit history and no settle-arm note is written (the #260 contract, widened).
- `dispatchAiReviewTurns` reads the task's category first and mints nothing when it left review. Every caller dispatches AFTER an in-review landing (submit's post-commit round-open dispatch, the verdict's lazy mint, a correction re-dispatch, an unblock resume, a park restore, a removal re-fire, the stalled-review sweep), so no legitimate turn is refused. Review turns take no dispatch claim, so this read only narrows the read→insert window — the flip's write-time gate stays the arbiter.
- SPEC.md: the WRITE-ENFORCED clause now states the in-review requirement, the new REVIEW-TURN MINT GATE clause is added, the sweep's caller-contract parenthetical no longer points at a pre-existing hole, and the waiting-answer clause states the widened gate.
- `test/unit/review-off-review-settle.test.ts` pins both arms with a mock that ENFORCES the rendered predicate (`in (...)` must contain the row's current status), so removing either guard turns the refusal cases red. Mutation-proved: dropping the mint gate fails 1 pin; dropping the flip gate fails 3; keying the allow-list on the seeded id fails 2.

## Verification

ts 0 · lint 0 · fmt 0 · unit 2310 passed · coverage 99.71% · build 0 · e2e 125 passed (0 failed). Mutation proofs above.

## Rollback

Revert the merge commit; no schema change, no data migration.

## Review

Blind-review rounds recorded here before merge.
