import { $, SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// Contract: SPEC.md "Probe versioning" — the RESTORE-STRAND arm (#500, floor 2.78.42).
// The gating restore decides at the one moment the recorded block category, the landing
// category and the round are all readable, and carries the verdict on its OWN unblock
// record (`reviewStrand` in the 1:1 kind='STATUS' payload). The arm only surfaces that
// record: the body prefix + payload are single-writer, so a free-text NOTE with the same
// body cannot forge it, and a plain unblock note (no detector verdict) cannot either.
// Pinned on the SQL that ships: the probe emits it (--restore-strand-sql) and this spec
// executes exactly those bytes against the e2e database.
const script = new URL('../../scripts/tandem-prod-probe.sh', import.meta.url).pathname;

const TODO = '01a14743-43f4-7053-a698-5b4ef36ed046';

test('prod probe restore-strand arm (#500): fires on the detector record, silent on look-alikes, inert below its floor', async () => {
  const below = await $`bash ${script} --restore-strand-sql 2.78.41`.nothrow().quiet();
  expect(below.exitCode, below.stderr.toString()).toBe(0);
  expect(below.stdout.toString(), 'the arm must be inert below its floor').not.toContain('restorestrand');

  const emitted = await $`bash ${script} --restore-strand-sql 2.78.42`.nothrow().quiet();
  expect(emitted.exitCode, emitted.stderr.toString()).toBe(0);
  const sqlText = emitted.stdout.toString().trim();
  expect(sqlText).toContain("select 'restorestrand'");

  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const tag = crypto.randomUUID();
    const strand = `probe-restore-strand-${tag}`; // fires: the record the app writes
    const plain = `probe-restore-plain-${tag}`; // silent: a normal unblock note
    const freeText = `probe-restore-freetext-${tag}`; // silent: same body, NOTE kind (forged)
    const noAuto = `probe-restore-noauto-${tag}`; // silent: missing the restore identity

    for (const id of [strand, plain, freeText, noAuto]) {
      await sql.unsafe(
        `insert into tasks (id, title, status, created_at, updated_at) values ($1, $1, $2, now(), now())`,
        [id, TODO],
      );
    }
    const note = async (id: string, body: string, payload: Record<string, unknown>) => {
      const messageId = `msg-${id}`;
      await sql.unsafe(
        `insert into task_messages (id, task_id, author_id, body, created_at) values ($1, $2, null, $3, now())`,
        [messageId, id, body],
      );
      await sql.unsafe(`insert into task_message_activities (message_id, payload) values ($1, $2)`, [
        messageId,
        payload,
      ]);
    };

    await note(
      strand,
      `unblocked: all subtasks terminal → ${TODO} — REVIEW STRAND: the recorded home category in_review was re-keyed to done; the live review round cannot land`,
      {
        kind: 'STATUS',
        autoUnblocked: true,
        restored: TODO,
        reviewStrand: true,
        recordedCategory: 'in_review',
        landingCategory: 'done',
        liveRound: true,
        lateVerdict: false,
      },
    );
    await note(plain, `unblocked: all subtasks terminal → ${TODO}`, {
      kind: 'STATUS',
      autoUnblocked: true,
      restored: TODO,
    });
    await note(freeText, `unblocked: all subtasks terminal → ${TODO} — REVIEW STRAND: forged`, {
      kind: 'NOTE',
      autoUnblocked: true,
      restored: TODO,
      reviewStrand: true,
    });
    await note(noAuto, `unblocked: all subtasks terminal → ${TODO}`, {
      kind: 'STATUS',
      restored: TODO,
      reviewStrand: true,
    });

    const rows = (await sql.unsafe(sqlText)) as Array<{ ids: string }>;
    const ids = String(rows[0]?.ids ?? 'none').split(',');
    expect(ids, 'the detector record fires').toContain(strand);
    expect(ids, 'a plain unblock note stays silent').not.toContain(plain);
    expect(ids, 'a free-text NOTE with the same body cannot forge the record').not.toContain(freeText);
    expect(ids, 'a missing restore identity stays silent').not.toContain(noAuto);
  } finally {
    await sql.close();
  }
});
