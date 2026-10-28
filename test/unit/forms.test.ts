import { describe, expect, it } from 'vitest';

import { NONE_ID, errorMessage, saveFailed } from '../../app/utils/forms';

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

  it('saveFailed names the object (and verb) in the fallback, server message still wins', () => {
    expect(saveFailed({}, 'employee')).toBe("Couldn't save the employee — try again");
    expect(saveFailed({}, 'provider', 'delete')).toBe("Couldn't delete the provider — try again");
    expect(saveFailed({}, 'connection', 'probe')).toBe("Couldn't probe the connection — try again");
    expect(saveFailed({ data: { json: { message: 'a title with that name already exists' } } }, 'title')).toBe(
      'a title with that name already exists',
    );
  });
});
