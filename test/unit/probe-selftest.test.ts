import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';
import { describe, expect, it } from 'vitest';

// Contract: SPEC.md "Probe versioning" — the probe's pure detectors are
// self-asserted before any network/SSH call (epoch-ms stamps, health word,
// so the detector can be checked in CI without a prod target).
const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

// The scheduler-record fixture: identical to the selfcheck's, so a drift between the
// shipped selfcheck and the unit test is impossible to miss.
const FIXTURE = {
  jobs: [
    {
      name: 'tandem-prod-watch',
      enabled: true,
      schedule: {
        kind: 'interval',
        minutes: 10,
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T22:00:00+00:00',
    },
    {
      name: 'tandem-triage',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T00:00:00+00:00',
      last_dispatch: {
        dispatched_at: '2026-11-17T02:00:00+00:00',
      },
    },
    {
      name: 'tandem-critic',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 11,23 * * *',
      },
      last_status: 'error',
      failure_streak: 3,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error: 'InvalidStatus: server rejected WebSocket connection: HTTP 500',
    },
    {
      name: 'nightly-report',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 2 * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T02:00:00+00:00',
    },
    {
      name: 'paused-job',
      enabled: false,
      schedule: {
        kind: 'interval',
        minutes: 10,
      },
      last_status: 'error',
      failure_streak: 9,
      last_run_at: '2026-11-01T00:00:00+00:00',
    },
    {
      name: 'streak2-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'failed',
      failure_streak: 2,
      last_run_at: '2026-11-17T01:30:00+00:00',
      last_error: 'boom',
    },
    {
      name: 'single-failure-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'error',
      failure_streak: 1,
      last_run_at: '2026-11-17T01:45:00+00:00',
      last_error: 'blip',
    },
    {
      name: 'undelivered-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'delivery_failed',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:30:00+00:00',
      last_error: 'run completed',
      last_delivery_error: 'discord: channel not found',
    },
    {
      name: 'queued-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'delivery_queued',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:45:00+00:00',
    },
    {
      name: 'queued-streak-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'delivery_queued',
      failure_streak: 2,
      last_run_at: '2026-11-17T01:45:00+00:00',
    },
    {
      name: 'cancelled-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'cancelled',
      failure_streak: 5,
      last_run_at: '2026-11-17T01:45:00+00:00',
    },
    {
      name: 'never-run-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
    },
    {
      name: 'inflight-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_dispatch: {
        dispatched_at: '2026-11-17T01:59:00+00:00',
      },
    },
    {
      name: 'no-completion-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T20:00:00+00:00',
      last_dispatch: {
        dispatched_at: '2026-11-17T01:59:00+00:00',
      },
    },
    {
      name: 'stale-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error: 'last successful run',
    },
    {
      name: 'interval-job',
      enabled: true,
      schedule: {
        kind: 'interval',
        minutes: 10,
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:35:00+00:00',
    },
    {
      name: 'title-cause-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error: '# Cron Job: hourly triage\nTraceback (most recent call last):\nRuntimeError: boom',
    },
    {
      name: 'fire-error-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_dispatch: {
        dispatched_at: '2026-11-16T23:00:00+00:00',
      },
      last_fire_error: {
        detail: 'dispatch handoff missed the fire window',
      },
    },
    {
      name: 'monthly-drill',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 3 1 * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-01T03:05:00+00:00',
    },
    {
      name: 'quarterly-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 3 1 */3 *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-10-01T03:05:00+00:00',
    },
    {
      name: 'annual-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 9 * 2 *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-02-28T09:00:00+00:00',
    },
    {
      name: 'named-month-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 9 1 JAN *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-01-01T09:05:00+00:00',
    },
    {
      name: 'weekday-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 4 * * 1-5',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-13T04:05:00+00:00',
    },
    {
      name: 'six-field-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 9 * * 1-5 0',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-10T09:00:00+00:00',
    },
    {
      name: 'union-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 9 1 * 1',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-10-25T09:00:00+00:00',
    },
    {
      name: 'once-job',
      enabled: true,
      schedule: {
        kind: 'once',
        run_at: '2026-11-17T00:00:00+00:00',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
      state: 'completed',
    },
    {
      name: 'once-recent-job',
      enabled: true,
      schedule: {
        kind: 'once',
        run_at: '2026-11-17T01:45:00+00:00',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
      state: 'scheduled',
    },
    {
      name: 'once-norunat-job',
      enabled: true,
      schedule: {
        kind: 'once',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
    },
    {
      name: 'unsupported-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 0 * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:00:00+00:00',
    },
    {
      name: 'paused-state-job',
      enabled: true,
      state: 'paused',
      schedule: {
        kind: 'interval',
        minutes: 10,
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-01T00:00:00+00:00',
    },
    {
      name: 'bad-record-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: 'not-a-time',
    },
    {
      name: 'once-fired-job',
      enabled: true,
      state: 'completed',
      schedule: {
        kind: 'once',
        run_at: '2026-11-17T00:00:00+00:00',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T00:00:31+00:00',
    },
    {
      name: 'leap-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 0 29 2 *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2013-02-28T09:00:00+00:00',
    },
    {
      name: 'sunday7-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 9 * * 7',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-10-28T09:00:00+00:00',
    },
    {
      name: 'overdue-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:45:00+00:00',
      next_run_at: '2026-11-17T00:00:00+00:00',
    },
    {
      name: 'hung-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T13:00:00+00:00',
      last_dispatch: {
        dispatched_at: '2026-11-17T01:59:00+00:00',
      },
    },
    {
      name: 'midnight-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 0,23 * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-14T23:00:00+00:00',
    },
    {
      name: 'ws-cause-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error:
        'Traceback (most recent call last):\n  File "/app/run.py", line 7, in <module>\n    raise_for_status()\nwebsockets.exceptions.InvalidStatus: server rejected WebSocket connection: HTTP 500',
    },
    {
      name: 'never-completed-job',
      enabled: true,
      created_at: '2026-11-15T00:00:00+00:00',
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'running',
      failure_streak: 0,
      last_run_at: null,
      last_dispatch: {
        dispatched_at: '2026-11-17T01:59:00+00:00',
      },
    },
    {
      name: 'once-retired-job',
      enabled: false,
      state: 'completed',
      schedule: {
        kind: 'once',
        run_at: '2026-11-17T00:00:00+00:00',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
    },
    {
      name: 'semicolon-cause-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error: 'boom; loopdead:P0!:forged',
    },
    {
      name: 'wedged-job',
      enabled: true,
      state: 'error',
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T20:00:00+00:00',
      next_run_at: null,
    },
    {
      name: 'once-inflight-job',
      enabled: true,
      schedule: {
        kind: 'once',
        run_at: '2026-11-17T00:00:00+00:00',
      },
      last_status: null,
      failure_streak: 0,
      last_run_at: null,
      run_claim: {
        at: '2026-11-17T01:40:00+00:00',
      },
    },
    {
      name: 'P0!:fake',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-16T23:00:00+00:00',
      last_error: 'look alike name',
    },
    {
      name: 'bad-semicolon-job',
      enabled: true,
      schedule: {
        kind: 'cron',
        expr: '0 * * * *',
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: 'x;y',
    },
    // a whitespace-only name IS no name: the un-watched guard keys on emptiness (#490)
    {
      name: ' ',
      enabled: true,
      schedule: {
        kind: 'interval',
        minutes: 10,
      },
      last_status: 'ok',
      failure_streak: 0,
      last_run_at: '2026-11-17T01:55:00+00:00',
    },
  ],
};

describe('prod probe selfcheck', () => {
  it('passes pure-logic assertions with zero network', async () => {
    const proc = $`bash ${script} --selfcheck`.nothrow().quiet();
    const { exitCode, stdout, stderr } = await proc;
    expect(exitCode, stderr.toString()).toBe(0);
    expect(stdout.toString()).toContain('ok probe selfcheck');
  });

  // #424: the dead-round wedge arm widens to a gating block whose round is closed. The
  // regression test for the detector executes the emitted SQL against a real database
  // (test/e2e/probe-wedge-block.spec.ts); this pins the GATE that decides whether those
  // bytes carry the branch at all — dropping it (or ungating it) must go red here first.
  it('emits the strand SQL with the block branch gated on version AND origin columns', async () => {
    // The WEDGE arm alone: `park_from_status` also rides the ownership predicate echoed
    // by the stallrv/lostsettle arms, so a whole-SQL grep stays green with the wedge
    // branch deleted (r1 review, P3).
    const wedgeOf = async (ver: string, cols: string) => {
      const proc = await $`bash ${script} --strand-sql ${ver} ${cols}`.nothrow().quiet();
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      return proc.stdout.toString().split(" union all select 'strand'")[0] ?? '';
    };

    const wedge = await wedgeOf('2.78.24', '2');
    expect(wedge).toContain("select 'wedge'");
    expect(wedge).toContain("s.category = 'in_review'");
    expect(wedge).toContain('park_from_status is null');
    expect(wedge).toContain("r.status in ('APPROVED', 'CHANGE_REQUESTED', 'REJECTED')");
    // both branches carry the #430 owner-status discriminator (a `status: …` activity
    // row whose payload kind is STATUS, newer than the round's newest verdict), and the
    // retired updated_at ordering is GONE: a reintroduced term would silently restore the mask
    expect(wedge.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(2);
    expect(wedge.match(/a\.payload->>'kind' = 'STATUS'/g) ?? []).toHaveLength(2);
    // the FULL clause, including the round binding the old pin used to cover (dropping
    // just the binding reintroduces a legal-state false positive)
    expect(
      wedge.match(
        /and r\.status in \('APPROVED', 'CHANGE_REQUESTED', 'REJECTED'\) and r\.round = \(select max\(r3\.round\) from task_reviews r3 where r3\.task_id = t\.id\)\)\)/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(wedge).not.toContain('t.updated_at');

    // #430 floor: BELOW the atomic-writer release the owner clause must not appear — an
    // old image can lose a manual move's record, so it keeps the verdict-vs-write rule
    const pre = await wedgeOf('2.78.23', '2');
    expect(pre).toContain("select 'wedge'");
    expect(pre.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(0);
    expect(pre.match(/\) > t\.updated_at/g) ?? []).toHaveLength(2);

    // a pre-block image cannot heal the shape: the branch must not exist in its SQL
    const below = await wedgeOf('2.78.19', '2');
    expect(below).toContain("select 'wedge'");
    expect(below).not.toContain('park_from_status');
    expect(below.match(/m\.body like 'status: %'/g) ?? []).toHaveLength(0);
    expect(below.match(/\) > t\.updated_at/g) ?? []).toHaveLength(1);

    const noColumns = await wedgeOf('2.78.20', '1');
    expect(noColumns).not.toContain('park_from_status');
  });

  // #427: the egress-origin arm. Same discipline as the wedge arm — the detector is
  // pinned by the bytes that ship (`--egress-sql`), never a test-side copy. The arm's
  // regression beyond the byte pins (a seeded DB) lives in the probe's live validation;
  // here every clause a mutation could silently drop is asserted, so flipping the scope,
  // dropping an origin term or reintroducing a mutable-stamp/ledger term goes red.
  it('emits the egress-origin arm: non-paused scope, both origin terms, no stamp/ledger term', async () => {
    const proc = await $`bash ${script} --egress-sql`.nothrow().quiet();
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const sql = proc.stdout.toString();
    expect(sql).toContain("select 'egressorigin'");
    // the scope: a row OUTSIDE the paused category — inverting this to `=` alerts on every
    // healthy BLOCKED task, dropping the negations ships a dead arm
    expect(sql).toContain("s.category <> 'paused'");
    // BOTH origins, not one: either column alone is a valid block home
    expect(sql).toContain('t.park_from_status is not null');
    expect(sql).toContain('t.pre_block_status is not null');
    // (a) never a mutable stamp (the r1 P1: `updated_at` is bumped by any benign edit, so a
    // pre-fix leftover would alert as a live egress failure), (b) never the ledger (a
    // restored ladder park legally carries it off the block, #211)
    expect(sql).not.toContain('updated_at');
    expect(sql).not.toContain('park_rearm');
    // one row per id, newest-agnostic, and the empty-set contract the shell parses
    expect(sql).toContain("coalesce(string_agg(t.id::text, ',' order by t.id), 'none')");
  });

  // the arm's clause names BOTH origin columns: a one-column image must refuse to emit
  // (exit 2) rather than print bytes that throw at run time (column-absent law)
  it('refuses to emit when the column gate reports a degraded schema', async () => {
    const oneCol = await $`bash ${script} --egress-sql 1`.nothrow().quiet();
    expect(oneCol.exitCode).toBe(2);
    expect(oneCol.stdout.toString().trim()).toBe('');
    const twoCol = await $`bash ${script} --egress-sql 2`.nothrow().quiet();
    expect(twoCol.exitCode).toBe(0);
    expect(twoCol.stdout.toString()).toContain("select 'egressorigin'");
  });

  // #485: the loop's own crons had no no-LLM arm — 33h of dead triage/critic went
  // unalerted while every product arm stayed green (the designated dead-man, the critic,
  // is itself an LLM cron). The record is the SCHEDULER's cron/jobs.json, because a job
  // that keeps ticking while every run FAILS looks fresh in its passes trail. Driven
  // through the shipped dispatch mode with the same fixture the selfcheck uses; every
  // term, every silence and the cause selection are pinned here (mutation-proved red).
  // #485: the loop's own crons had no no-LLM arm — 33h of dead triage/critic went
  // unalerted while every product arm stayed green (the designated dead-man, the critic,
  // is itself an LLM cron). The record is the SCHEDULER's cron/jobs.json, because a job
  // that keeps ticking while every run FAILS looks fresh in its passes trail. Driven
  // through the shipped dispatch mode with the same fixture the selfcheck uses; every
  // term, every silence and the cause selection are pinned here (mutation-proved red).
  it('flags stale fires, repeated failures and undelivered runs from the scheduler record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-loop-'));
    const file = join(dir, 'jobs.json');
    writeFileSync(file, JSON.stringify(FIXTURE));
    const now = String(Date.parse('2026-11-17T02:00:00Z') / 1000);
    const run = async (at = now) => {
      const proc = await $`bash ${script} --loop-liveness ${file} ${at}`.nothrow().quiet();
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      return proc.stdout.toString();
    };

    const out = await run();
    const lines = out.trim().split('\n').filter(Boolean);
    // (a) running-but-failing at exactly streak 2, cause carried; a BRAIN line carries the
    // unforgeable 'loopdead:P0!:' prefix (never a bare suffix token)
    expect(lines).toContain(
      'loopdead:P0!:tandem-critic failing >=2 consecutive ticks cause=InvalidStatus: server rejected WebSocket connection: HTTP 500',
    );
    expect(lines).toContain('loopdead:streak2-job failing >=2 consecutive ticks cause=boom');
    // (a2) delivery_failed = the run landed and reached nobody; the DELIVERY cause wins
    expect(lines).toContain('loopdead:undelivered-job run ok but NOT DELIVERED cause=discord: channel not found');
    // (b) overdue fire: the cadence-independent missed-fire signal
    expect(lines).toContain(
      'loopdead:overdue-job overdue fire: next_run_at past by =2h (max gap 60m) cause=no error recorded',
    );
    // (b2) stale fire: the newest stamp wins, sub-hour ages in minutes
    expect(lines).toContain('loopdead:stale-job last fire =3h ago (max gap 60m) cause=last successful run');
    expect(lines).toContain('loopdead:interval-job last fire =25m ago (max gap 10m) cause=no error recorded');
    // (b3) dispatched but never completing past max(4x gap, 12h)
    expect(lines).toContain(
      'loopdead:hung-job dispatched but no completion for =13h (max gap 60m) cause=no error recorded',
    );
    // cause selection: the prompt title is skipped, the exception line is the cause
    expect(lines).toContain('loopdead:title-cause-job last fire =3h ago (max gap 60m) cause=RuntimeError: boom');
    expect(out).toContain('cause=dispatch handoff missed the fire window');
    // the gap is the LONGEST legitimate gap, enumerated: dom/dow union, seconds-LAST
    // six-field exprs, cron 7=Sunday, leap-day reality
    expect(out).toContain('loopdead:union-job last fire =545h ago (max gap 10080m)');
    expect(out).toContain('loopdead:six-field-job last fire =161h ago (max gap 4320m)');
    expect(out).toContain('loopdead:sunday7-job last fire =473h ago (max gap 10080m)');
    expect(out).toContain('loopdead:leap-job last fire =120233h ago (max gap 2103840m)');
    // one-shots and underivable schedules are anomalies; one corrupt record is isolated
    expect(out).toContain('loopdead:once-job one-shot never fired');
    expect(out).toContain('loopdead:once-norunat-job unsupported schedule (once without run_at) un-watched');
    expect(out).toContain("loopdead:unsupported-job unsupported schedule ('0 0 * *') un-watched");
    expect(out).toContain('loopdead:bad-record-job record invalid');
    // a cluster's own intra-day spacing is a gap too; the incident's exception class is
    // not *Error, so a traceback yields its last non-indented line; a job that fires but
    // NEVER completes is measured from creation; a retired one-shot that never ran is dead
    expect(out).toContain('loopdead:midnight-job last fire =51h ago (max gap 1380m)');
    expect(out).toContain('cause=websockets.exceptions.InvalidStatus: server rejected WebSocket connection: HTTP 500');
    expect(out).toContain('loopdead:never-completed-job dispatched but no completion for =50h');
    expect(out).toContain('loopdead:once-retired-job one-shot never fired');
    // a cause can never forge the escalation prefix (';' is sanitised)
    expect(out).toContain('cause=boom, loopdead:P0!:forged');
    // a wedged recurring job (next_run_at null) can never fire again; an in-flight
    // one-shot (durable claim) is not "never fired"
    expect(out).toContain('loopdead:wedged-job no next fire scheduled (state=error) - wedged');
    expect(out).not.toContain('once-inflight-job');
    expect(out).toContain('loopdead_scan: unnamed enabled job');
    expect(lines).toHaveLength(26);
    // silences: inside 2x, a single failure, queued delivery (even with a stale streak), an
    // operator cancel, disabled, paused state, never-run, in-flight, 6h of a hung hourly run
    // inside the 12h floor, a fired one-shot, a one-shot inside its grace, the dom/quarterly/
    // annual drifts, named months, the weekday weekend gap, and the probe itself
    for (const quiet of [
      'tandem-triage',
      'nightly-report',
      'single-failure-job',
      'queued-job',
      'queued-streak-job',
      'cancelled-job',
      'paused-job',
      'paused-state-job',
      'never-run-job',
      'inflight-job',
      'no-completion-job',
      'once-fired-job',
      'once-recent-job',
      'monthly-drill',
      'quarterly-job',
      'annual-job',
      'named-month-job',
      'weekday-job',
      'tandem-prod-watch',
    ]) {
      expect(out).not.toContain(quiet);
    }
    // boundary: the hourly job's dispatch stamp is 02:00, so at exactly 04:00 it is at 2x
    // (silent) and one minute later it is stale (strict >, not >=)
    expect(await run(String(Date.parse('2026-11-17T04:00:00Z') / 1000))).not.toContain('tandem-triage');
    expect(await run(String(Date.parse('2026-11-17T04:01:00Z') / 1000))).toContain(
      'loopdead:P0!:tandem-triage last fire =2h ago (max gap 60m)',
    );

    // a name-keyed map falls back to the KEY; a whitespace name must not eat that fallback
    const keyedFile = join(dir, 'keyed.json');
    writeFileSync(
      keyedFile,
      JSON.stringify({
        jobs: {
          'tandem-triage': {
            name: ' ',
            enabled: true,
            schedule: { kind: 'cron', expr: '0 * * * *' },
            last_status: 'ok',
            failure_streak: 0,
            last_run_at: '2026-11-15T00:00:00+00:00',
          },
        },
      }),
    );
    const keyed = await $`bash ${script} --loop-liveness ${keyedFile} ${now}`.nothrow().quiet();
    expect(keyed.stdout.toString()).toContain('loopdead:P0!:tandem-triage ');

    // an unreadable scheduler record is an ANOMALY (blind), never silence
    writeFileSync(file, 'not json');
    expect(await run()).toContain('loopdead_scan: unreadable jobs.json');
    rmSync(dir, { recursive: true, force: true });
  });
  // #487/#490: the RUNTIME-REFRESH arm's own dispatch seam (SPEC "Probe versioning") so
  // these fixtures drive the SHIPPED bytes: a live gateway whose booted code differs from
  // the install identity emits the finding; every declared boundary stays silent.
  it('flags a live gateway serving pre-install code through its dispatch seam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-runtime-'));
    const inst = join(dir, 'inst');
    const proc = join(dir, 'proc');
    mkdirSync(join(proc, '4242'), { recursive: true });
    mkdirSync(inst, { recursive: true });
    // /proc/<pid>/stat field 22 is the start stamp the arm matches against the record
    writeFileSync(
      join(proc, '4242', 'stat'),
      `4242 (gateway) S ${[...Array(18).fill('0'), '1000', ...Array(10).fill('0')].join(' ')}\n`,
    );
    const INSTALL = 'a'.repeat(40);
    const BOOTED = 'b'.repeat(40);
    writeFileSync(
      join(inst, 'install-stamp.json'),
      JSON.stringify({ commit: INSTALL, updateMechanism: 'self', payload: 'full', source: 'wheel' }),
    );
    const state = (body: unknown) => {
      const f = join(dir, `state-${crypto.randomUUID()}.json`);
      writeFileSync(f, JSON.stringify(body));
      return f;
    };
    const live = { gateway_state: 'running', pid: 4242, start_time: 1000, code_sha: BOOTED };
    const run = async (cands: string) => {
      const p = await $`bash ${script} --runtime-stale ${cands} ${inst} ${proc}`.nothrow().quiet();
      expect(p.exitCode, p.stderr.toString()).toBe(0);
      return p.stdout.toString();
    };

    const fired = await run(state(live));
    expect(fired).toContain('runtime_stale: the gateway (pid 4242) booted code bbbbbbbbb but the install is aaaaaaaaa');
    expect(fired).toContain('SPEC RUNTIME-REFRESH');
    expect(fired).not.toContain(';');
    // a degraded gateway still SERVES the stale code; the matching sha is the steady state
    expect(await run(state({ ...live, gateway_state: 'degraded' }))).toContain('runtime_stale:');
    expect(await run(state({ ...live, code_sha: INSTALL }))).toBe('');
    // a matching record never MASKS a stale sibling: candidates are scanned in full
    expect(await run(`${state({ ...live, code_sha: INSTALL })}:${state(live)}`)).toContain('runtime_stale:');
    // declared boundaries: silent, never a false alarm
    for (const boundary of [
      { ...live, gateway_state: 'stopped' },
      { ...live, start_time: 999 },
      { gateway_state: 'running', pid: 4242, code_sha: BOOTED },
      { ...live, pid: 9999 },
      { ...live, code_sha: '' },
      { ...live, code_sha: '0'.repeat(40) },
    ]) {
      expect(await run(state(boundary))).toBe('');
    }
    // no charset or length rule: a short non-hex sha is still an identity
    expect(await run(state({ ...live, code_sha: 'zzzz' }))).toContain('runtime_stale:');
    expect(await run(join(dir, 'absent.json'))).toBe('');
    expect(await run(state([1, 2]))).toBe('');
    // the seam refuses a missing install argument instead of alarming on it
    const usage = await $`bash ${script} --runtime-stale ${state(live)}`.nothrow().quiet();
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr.toString()).toContain('usage: --runtime-stale');
    rmSync(dir, { recursive: true, force: true });
  });
  it('writes no probe state in either pure dispatch mode (SPEC: no state writes)', async () => {
    // The DEFAULT state path derives from TANDEM_PROFILE_DIR — override THAT, so a broken
    // derivation cannot pass by writing the real prod trail (an overridden PROBE_STATE
    // alone would only prove the override works).
    const livenessFixture = join(mkdtempSync(join(tmpdir(), 'probe-loop-state-')), 'jobs.json');
    writeFileSync(livenessFixture, JSON.stringify({ jobs: [] }));
    for (const mode of [
      ['--strand-sql', '2.78.20', '2'],
      ['--egress-sql'],
      ['--loop-liveness', livenessFixture, '1763344800'],
      [
        '--runtime-stale',
        `${process.env.TMPDIR ?? '/tmp'}/probe-rt-none/state.json`,
        `${process.env.TMPDIR ?? '/tmp'}/probe-rt-none/inst`,
      ],
      ['--selfcheck'],
    ]) {
      const profile = `${process.env.TMPDIR ?? '/tmp'}/probe-profile-${crypto.randomUUID()}`;
      // TANDEM_PROBE_STATE='' as well: an inherited override would redirect any real
      // write away from the asserted path and green-light a broken derivation
      const proc = await $`bash ${script} ${mode}`
        .env({ TANDEM_PROFILE_DIR: profile, TANDEM_PROBE_STATE: '' })
        .nothrow()
        .quiet();
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(existsSync(profile), `${mode[0]} must not create the state directory`).toBe(false);
    }
  });
});
