// isUuid: the ONE canonical uuid shape check the routers use before comparing a
// uuid-typed column (a malformed value would raise Postgres 22P02 → 500).
import { describe, expect, it } from 'vitest';

import { isUuid } from '../../shared/utils/is-uuid.ts';

describe('isUuid', () => {
  it('accepts canonical uuids — any version, case-insensitive', () => {
    expect(isUuid('01a14743-43f4-7053-a698-5b4ef36ed046')).toBe(true); // v7
    expect(isUuid('9f8e7d6c-5b4a-4321-8fed-cba987654321')).toBe(true); // v4
    expect(isUuid('01A14743-43F4-7053-A698-5B4EF36ED046')).toBe(true); // uppercase
  });

  it('rejects anything a uuid column cannot parse', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('01a14743-43f4-7053-a698-5b4ef36ed04')).toBe(false); // short
    expect(isUuid('01a14743-43f4-7053-a698-5b4ef36ed0467')).toBe(false); // long
    expect(isUuid('01a1474343f47053a6985b4ef36ed046')).toBe(false); // bare hex
    expect(isUuid('01a14743-43f4-7053-a698-5b4ef36ed04g')).toBe(false); // non-hex
    expect(isUuid(' 01a14743-43f4-7053-a698-5b4ef36ed046')).toBe(false); // padded
    expect(isUuid('{01a14743-43f4-7053-a698-5b4ef36ed046}')).toBe(false); // braces
  });
});
