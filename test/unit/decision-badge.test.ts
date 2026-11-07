// DECISION-VISIBILITY LAW + ROTATION LOCK: the badge's tasks.inbox read is
// session-tier, so the query gate must refuse the signed-out shell AND the
// forced-password-rotation screen (a locked session may reach one procedure).
import { describe, expect, it } from 'vitest';

import { decisionBadgeEnabled } from '../../app/utils/decision-badge.ts';

describe('decisionBadgeEnabled', () => {
  it('enables the count only for a signed-in, unlocked session', () => {
    expect(decisionBadgeEnabled({ mustChangePassword: false })).toBe(true);
    expect(decisionBadgeEnabled({})).toBe(true);
  });

  it('refuses the rotation-locked and signed-out shells', () => {
    expect(decisionBadgeEnabled({ mustChangePassword: true })).toBe(false);
    expect(decisionBadgeEnabled(null)).toBe(false);
    expect(decisionBadgeEnabled(undefined)).toBe(false);
  });
});
