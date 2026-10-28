// shared copy: the unreachable-server string is one constant, so the surfaces
// that render it cannot drift apart
import { describe, expect, it } from 'vitest';

import { SERVER_UNREACHABLE_COPY } from '../../app/utils/copy.ts';

describe('SERVER_UNREACHABLE_COPY', () => {
  it('is a complete sentence that tells the reader what to do', () => {
    expect(SERVER_UNREACHABLE_COPY).toContain('Try again');
    expect(SERVER_UNREACHABLE_COPY.endsWith('.')).toBe(true);
  });
});
