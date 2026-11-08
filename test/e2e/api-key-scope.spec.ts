import { expect, test } from './helpers/cleanup';

// SPEC "Roles & access" — CREDENTIAL-METADATA SCOPE: the access-key read is
// self-or-admin. Key metadata is not roster data: an EMPLOYEE session (here an
// agent API key, the same credential class an AI employee uses) reads only its
// OWN keys, and another employee's id reads as NOT_FOUND — the same miss a
// malformed uuid gets (a uuid column cannot compare a non-uuid, so an unguarded
// handler answers 500 instead of the specced miss). ADMIN keeps the roster view.
const BASE_URL = process.env.TANDEM_E2E_URL || 'http://localhost:4100';

type CreatedEmployee = { id: string; userId: string; apiKey: string };
type KeyRow = { id: string; name: string };

async function createEmployee(page: import('@playwright/test').Page, tag: string): Promise<CreatedEmployee> {
  const res = await page.request.post('/rpc/employees/create', {
    data: {
      json: {
        name: `Keys ${tag}`,
        // unique per run: the email must be free (employees.create asserts it)
        email: `keys-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@tandem.local`,
        kind: 'human',
        title: 'Tester',
      },
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).json as CreatedEmployee;
}

test('access-key reads are self-or-admin; a malformed employee id is a miss, not a 500', async ({
  page,
  playwright,
}) => {
  const own = await createEmployee(page, 'a');
  const other = await createEmployee(page, 'b');
  expect(own.apiKey).toBeTruthy();

  // the employee credential is the minted access key — a session-tier read
  const asEmployee = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'x-api-key': own.apiKey },
  });
  try {
    const self = await asEmployee.post('/rpc/employees/listApiKeys', {
      data: { json: { employeeId: own.id } },
    });
    expect(self.status()).toBe(200);
    const selfKeys = (await self.json()).json as KeyRow[];
    expect(selfKeys.length).toBe(1); // the key minted at create

    // another employee's key inventory is out of scope for an employee session
    const peek = await asEmployee.post('/rpc/employees/listApiKeys', {
      data: { json: { employeeId: other.id } },
    });
    expect(peek.status()).toBe(404);
    expect(JSON.stringify(await peek.json())).toContain('employee not found');

    // a malformed id is the same miss for an employee session (answered by the
    // self-scope clause — the shape guard's own subject is the ADMIN leg below)
    const malformed = await asEmployee.post('/rpc/employees/listApiKeys', {
      data: { json: { employeeId: 'not-a-uuid' } },
    });
    expect(malformed.status()).toBe(404);
    expect(JSON.stringify(await malformed.json())).toContain('employee not found');
  } finally {
    await asEmployee.dispose();
  }

  // ADMIN reads any employee's keys (the employees page drawer depends on it)
  const admin = await page.request.post('/rpc/employees/listApiKeys', {
    data: { json: { employeeId: other.id } },
  });
  expect(admin.status()).toBe(200);
  expect(((await admin.json()).json as KeyRow[]).length).toBe(1);

  // …and a malformed id must not reach the uuid column on the admin path either:
  // this is the only caller the self-scope clause lets through, so without the
  // shape guard this leg answers 500 (22P02), not the specced miss
  const adminMalformed = await page.request.post('/rpc/employees/listApiKeys', {
    data: { json: { employeeId: 'not-a-uuid' } },
  });
  expect(adminMalformed.status()).toBe(404);
  expect(JSON.stringify(await adminMalformed.json())).toContain('employee not found');
});
