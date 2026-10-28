import { describe, expect, it } from 'vitest';

import { formatWhen } from '../../app/utils/format-when';
import { NONE_ID, errorMessage } from '../../app/utils/forms';

describe('forms (shared helpers)', () => {
  it('exposes the none-sentinel pickers map back to null', () => {
    expect(NONE_ID).toBe('__none__');
  });

  it('errorMessage reads the oRPC nested message first', () => {
    const orpcError = { data: { json: { message: 'No real DB' } } };
    expect(errorMessage(orpcError, 'fallback')).toBe('No real DB');
    expect(errorMessage({ data: { message: 'flat' } }, 'fallback')).toBe('flat');
    expect(errorMessage(new Error('plain'), 'fallback')).toBe('plain');
    expect(errorMessage('junk', 'fallback')).toBe('fallback');
    expect(errorMessage({}, 'fallback')).toBe('fallback');
  });
});

describe('formatWhen', () => {
  it('renders date + HH:MM and tolerates junk', () => {
    const d = new Date(2026, 9, 27, 14, 30);
    expect(formatWhen(d)).toBe(
      d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    expect(formatWhen(d)).not.toMatch(/:\d{2}:\d{2}/);
    expect(formatWhen(null)).toBe('');
    expect(formatWhen('not-a-date')).toBe('');
  });
});
