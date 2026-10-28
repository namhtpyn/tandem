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

  it('drops seconds — date + HH:MM only', () => {
    const withSeconds = new Date(2026, 9, 27, 14, 30, 9);
    const without = new Date(2026, 9, 27, 14, 30);
    expect(formatWhen(withSeconds)).toBe(
      without.toLocaleString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    expect(formatWhen(withSeconds)).not.toMatch(/:\d{2}:\d{2}/);
  });
});
