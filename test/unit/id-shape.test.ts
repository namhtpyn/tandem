// requireUuid: the ID-SHAPE LAW's one decision point — reads answer NOT_FOUND,
// writes answer BAD_REQUEST; the message is the handler's contract, never the
// driver's 22P02 text.
import { describe, expect, it } from 'vitest';

import { requireUuid } from '../../server/domains/kernel/id-shape.ts';

describe('requireUuid', () => {
  it('lets a canonical uuid through — any version, any case', () => {
    expect(() => requireUuid('01a14743-43f4-7053-a698-5b4ef36ed046', 'BAD_REQUEST', 'x')).not.toThrow();
    expect(() => requireUuid('01A14743-43F4-7053-A698-5B4EF36ED046', 'NOT_FOUND', 'x')).not.toThrow();
  });

  it('answers NOT_FOUND for a read/lookup miss', () => {
    try {
      requireUuid('not-a-uuid', 'NOT_FOUND', 'employee not found');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('NOT_FOUND');
      expect((e as { message?: string }).message).toBe('employee not found');
    }
  });

  it('answers BAD_REQUEST for malformed write input', () => {
    try {
      requireUuid('not-a-uuid', 'BAD_REQUEST', 'invalid employee id');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('BAD_REQUEST');
      expect((e as { message?: string }).message).toBe('invalid employee id');
    }
  });
});
