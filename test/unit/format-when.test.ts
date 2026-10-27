// formatWhen: null/invalid dates render empty (hydration-safe timestamp spans)
import { describe, expect, it } from 'vitest';

import { formatWhen } from '../../app/utils/format-when.ts';

describe('formatWhen', () => {
  it('formats a real date and empties null/undefined/invalid', () => {
    expect(formatWhen('2026-10-27T00:00:00Z')).not.toBe('');
    expect(formatWhen(new Date('2026-10-27T00:00:00Z'))).not.toBe('');
    expect(formatWhen(null)).toBe('');
    expect(formatWhen(undefined)).toBe('');
    expect(formatWhen('not-a-date')).toBe('');
  });
});
