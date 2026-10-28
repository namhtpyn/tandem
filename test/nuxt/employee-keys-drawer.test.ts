import { mountSuspended } from '@nuxt/test-utils/runtime';
// New-state coverage: the keys drawer's LOAD-FAILURE branch. In the nuxt test
// env there is no reachable /rpc backend, so listKeys fails — the drawer must
// surface the Retry affordance instead of the 'No keys yet' empty state (which
// would read as a lie about an employee who does have keys).
import { expect, it, vi } from 'vitest';

import EmployeeKeysDrawer from '~/components/EmployeeKeysDrawer.vue';

const employee = { id: 'test-employee-1', name: 'Ada' } as never;

it('a failing listKeys renders the Retry branch, never a fake empty state', async () => {
  const c = await mountSuspended(EmployeeKeysDrawer, { props: { open: false, employee } });
  // the open watcher drives the load — flip it like the parent drawer does
  await c.setProps({ open: true });
  // UModal teleports its content to document.body — assert there, not on the wrapper
  await vi.waitFor(
    () => {
      expect(document.body.textContent).toContain('Try again');
    },
    { timeout: 5_000 },
  );
  expect(document.body.textContent).not.toContain('No keys yet');
  // and no fabricated key rows
  expect(document.querySelectorAll('[data-testid="key-row"]').length).toBe(0);
});
