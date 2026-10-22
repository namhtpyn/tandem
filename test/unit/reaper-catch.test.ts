// The reaper's best-effort catch: a broken schema yields 0, never a rejection.
import { describe, expect, it } from 'vitest';

import './api-harness';
import { resetSchema } from './helpers/pg';

describe('reaper failure arm', () => {
  it('returns 0 when the DB schema is gone', async () => {
    await resetSchema(); // drop everything; migrations NOT re-applied
    const { reapStaleRuns } = await import('#server/domains/tasks/dispatcher.service');
    expect(await reapStaleRuns()).toBe(0);
  });
});
