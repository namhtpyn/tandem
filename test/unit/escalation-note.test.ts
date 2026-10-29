import { describe, expect, it } from 'vitest';

import { parseEscalationNote } from '../../server/domains/tasks/review.service';

// escalation body law: "escalate to <name> for reviewing — <why>"; a bare why
// (no explicit target) falls back to the direct supervisor at the call site.
describe('parseEscalationNote', () => {
  it('extracts target + why from the canonical shape', () => {
    expect(parseEscalationNote('escalate to Zed for reviewing — no vault access')).toEqual({
      targetName: 'Zed',
      why: 'no vault access',
    });
    expect(parseEscalationNote('Escalate to Ada Lovelace for reviewing: wrong domain')).toEqual({
      targetName: 'Ada Lovelace',
      why: 'wrong domain',
    });
  });

  it('a bare why carries no target', () => {
    expect(parseEscalationNote('I cannot judge this — outside my domain')).toEqual({
      targetName: null,
      why: 'I cannot judge this — outside my domain',
    });
  });
});
