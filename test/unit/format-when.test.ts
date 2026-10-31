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

import { formatDurationMs, turnDurationLabel } from '../../app/utils/format-when.ts';

describe('formatDurationMs', () => {
  it('sub-second spans read as <1s (negatives included — callers guard, we degrade)', () => {
    expect(formatDurationMs(0)).toBe('<1s');
    expect(formatDurationMs(999)).toBe('<1s');
    expect(formatDurationMs(-5)).toBe('<1s');
  });

  it('whole seconds render bare', () => {
    expect(formatDurationMs(1000)).toBe('1s');
    expect(formatDurationMs(59_999)).toBe('59s');
  });

  it('minutes carry padded seconds — fixed width reads as a duration', () => {
    expect(formatDurationMs(60_000)).toBe('1m 00s');
    expect(formatDurationMs(245_000)).toBe('4m 05s');
    expect(formatDurationMs(3599_999)).toBe('59m 59s');
  });

  it('hours carry padded minutes', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h 00m');
    expect(formatDurationMs(3_600_000 + 23 * 60_000 + 59_999)).toBe('1h 23m');
  });
});

describe('turnDurationLabel', () => {
  const start = '2026-10-31T10:00:00Z';
  const end = '2026-10-31T10:04:05Z';

  it('settled turns label their wall-clock span', () => {
    expect(turnDurationLabel(start, end)).toBe('4m 05s');
    expect(turnDurationLabel(new Date(start), new Date(end))).toBe('4m 05s');
  });

  it('unfinished turns (null finish) render nothing', () => {
    expect(turnDurationLabel(start, null)).toBe(null);
    expect(turnDurationLabel(start, undefined)).toBe(null);
    expect(turnDurationLabel(null, end)).toBe(null);
    expect(turnDurationLabel(undefined, end)).toBe(null);
  });

  it('unparsable timestamps render nothing', () => {
    expect(turnDurationLabel('nope', end)).toBe(null);
    expect(turnDurationLabel(start, 'nope')).toBe(null);
  });

  it('non-positive deltas (clock skew, same-instant) render nothing', () => {
    expect(turnDurationLabel(end, start)).toBe(null);
    expect(turnDurationLabel(start, start)).toBe(null);
  });
});
