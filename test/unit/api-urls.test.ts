// REST URL builders — one construction site each (api-urls.ts is the ONLY
// place these paths may live, so the tests pin the exact wire shapes).
import { describe, expect, it } from 'vitest';

import { attachmentUrl, employeeAvatarUrl, taskAttachmentsUrl } from '../../app/utils/api-urls';
import { TABLE_PAGE_SIZE } from '../../app/utils/pagination';

describe('api-urls', () => {
  it('builds the avatar endpoint from the USER id', () => {
    expect(employeeAvatarUrl('u-1')).toBe('/api/employees/u-1/avatar');
  });

  it('builds the attachment byte endpoint', () => {
    expect(attachmentUrl('att_9')).toBe('/api/attachments/att_9');
  });

  it('pins the one table page size', () => {
    expect(TABLE_PAGE_SIZE).toBe(20);
  });

  it('builds the task attachment upload endpoint', () => {
    expect(taskAttachmentsUrl('t-7')).toBe('/api/tasks/t-7/attachments');
  });
});
