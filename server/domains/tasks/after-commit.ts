// Post-commit work queue (#479). A borrowing caller's transaction can trigger resume
// side effects that are NOT transactional (a parked reviewer turn replay, the #369
// answer-holder heal, an extinguished-round settle, a reviewer dispatch). Running them
// before the caller commits lets a rollback strand a settle/dispatch with no restore
// row behind it, so the gating restore hands them back through this queue and the
// caller drains it after its commit. Its own module (not gating.service) so callers and
// tests use THE class — a hand-written double can drift from the failure semantics.
import { consola } from 'consola';

const log = consola.withTag('tandem');

export type AfterCommit = () => Promise<void>;

/**
 * FIFO queue of post-commit closures. A branded object (never a bare array) so a
 * borrowed call cannot be handed a throwaway `[]` and silently drop the work.
 * `drain` runs the closures one at a time: a THROWING closure is logged and the rest
 * still run (a resume failure must never skip the remaining work or suppress the
 * caller's own post-commit publish), and a STALLED closure leaves everything behind it
 * still queued rather than spliced away — but the drain cannot finish past a closure
 * that never settles, so the caller's publish waits behind it (declared boundary, #479:
 * no timeout is imposed on resume work). Draining is at-most-once — a closure runs
 * exactly once, and a second drain of an emptied queue is a no-op.
 */
export class AfterCommitQueue {
  readonly #work: AfterCommit[] = [];

  public defer(work: AfterCommit): void {
    this.#work.push(work);
  }

  /** run every queued closure in FIFO order; returns how many ran */
  public async drain(): Promise<number> {
    let ran = 0;
    for (let job = this.#work.shift(); job; job = this.#work.shift()) {
      try {
        await job();
      } catch (e) {
        log.warn('gating: post-commit resume failed:', e instanceof Error ? e.message : e);
      }
      ran += 1;
    }
    return ran;
  }

  /** closures not yet drained (a rollback path leaves them unrun) */
  public get pending(): number {
    return this.#work.length;
  }
}
