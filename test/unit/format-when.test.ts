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

import { formatWhenShort } from '../../app/utils/format-when.ts';

describe('formatWhenShort', () => {
  it('same-day renders the time only', () => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5);
    expect(formatWhenShort(d)).toBe(d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  });

  it('same-year drops the year; an older year keeps it', () => {
    const now = new Date();
    const thisYear = new Date(now.getFullYear(), 0, 2, 8, 30);
    const shortThis = formatWhenShort(thisYear);
    expect(shortThis).not.toContain(String(now.getFullYear()));
    expect(shortThis).toContain('2');

    const old = new Date(now.getFullYear() - 1, 0, 2, 8, 30);
    const shortOld = formatWhenShort(old);
    expect(shortOld).toContain(String(now.getFullYear() - 1));
  });

  it('empty and invalid render empty', () => {
    expect(formatWhenShort(null)).toBe('');
    expect(formatWhenShort(undefined)).toBe('');
    expect(formatWhenShort('nope')).toBe('');
  });
});
