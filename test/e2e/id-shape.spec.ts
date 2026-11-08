import type { Page } from '@playwright/test';

import { expect, test } from './helpers/cleanup';

// SPEC "API law" — ID-SHAPE LAW: a uuid-typed id that is not in canonical
// 8-4-4-4-12 form can never name a row, and handing the raw string to a uuid
// column makes Postgres raise 22P02 — a 500 instead of the specced answer.
// Reads answer NOT_FOUND (a malformed id is a miss), writes answer BAD_REQUEST
// (malformed input, never a missing-row claim), list filters answer the empty
// page. This spec pins one representative of each arm plus every wired site.
const MALFORMED = 'not-a-uuid';
// canonical shape, no row behind it — the same miss a real lookup answers
const ABSENT = '00000000-0000-4000-8000-000000000000';

type CreatedEmployee = { id: string; userId: string };
type CreatedKey = { id: string };

async function post(page: Page, path: string, json: unknown) {
  return page.request.post(`/rpc/${path}`, { data: { json } });
}

/** assert the RPC answers the specced code AND the specced message (a 400 with a
 *  raw Postgres 22P02 message would pass a status-only check while the client
 *  still sees driver internals) */
async function expectRpcError(page: Page, path: string, json: unknown, status: number, needle: string) {
  const res = await post(page, path, json);
  expect(res.status(), `${path} ${JSON.stringify(json)}`).toBe(status);
  expect(JSON.stringify(await res.json()), `${path} response`).toContain(needle);
}

async function createEmployee(page: Page, tag: string): Promise<CreatedEmployee> {
  const res = await post(page, 'employees/create', {
    name: `IdShape ${tag}`,
    email: `id-shape-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@tandem.local`,
    kind: 'human',
    title: 'Tester',
  });
  expect(res.status()).toBe(200);
  return (await res.json()).json as CreatedEmployee;
}

test('writes answer BAD_REQUEST for a malformed employee id — never a 22P02 500', async ({ page }) => {
  const employee = await createEmployee(page, 'emp');
  const keyRes = await post(page, 'employees/createApiKey', { employeeId: employee.id });
  expect(keyRes.status()).toBe(200);
  const key = (await keyRes.json()).json as CreatedKey;

  // employees.update / remove: the target id
  await expectRpcError(
    page,
    'employees/update',
    { id: MALFORMED, name: 'x', title: 'T', supervisorIds: [] },
    400,
    'invalid employee id',
  );
  await expectRpcError(page, 'employees/remove', { id: MALFORMED }, 400, 'invalid employee id');
  // access-key writes: every employee id in the input (target and owner scope)
  await expectRpcError(page, 'employees/createApiKey', { employeeId: MALFORMED }, 400, 'invalid employee id');
  await expectRpcError(page, 'employees/updateApiKey', { keyId: MALFORMED, name: 'x' }, 400, 'invalid api key id');
  await expectRpcError(
    page,
    'employees/updateApiKey',
    { keyId: key.id, employeeId: MALFORMED, name: 'x' },
    400,
    'invalid employee id',
  );
  await expectRpcError(page, 'employees/revokeApiKey', { keyId: MALFORMED }, 400, 'invalid api key id');
  await expectRpcError(
    page,
    'employees/revokeApiKey',
    { keyId: key.id, employeeId: MALFORMED },
    400,
    'invalid employee id',
  );
});

test('mcp binding surfaces: writes reject a malformed employee id, the list filter stays an empty page', async ({
  page,
}) => {
  // probe / remove / set / oauthConnect all key a uuid binding by employeeId
  await expectRpcError(
    page,
    'mcp/bindingsSet',
    { employeeId: MALFORMED, serverId: 'srv-x' },
    400,
    'invalid employee id',
  );
  await expectRpcError(
    page,
    'mcp/bindingsRemove',
    { employeeId: MALFORMED, serverId: 'srv-x' },
    400,
    'invalid employee id',
  );
  // probe reads one binding: blank and malformed ids are the same miss
  for (const employeeId of [MALFORMED, '']) {
    await expectRpcError(page, 'mcp/probe', { employeeId, serverId: 'srv-x' }, 404, 'binding not found');
  }
  await expectRpcError(
    page,
    'mcp/oauthConnect',
    { employeeId: MALFORMED, serverId: 'srv-x' },
    400,
    'invalid employee id',
  );

  // the read is a filter, not a lookup: blank and non-uuid values are the empty page
  for (const employeeId of [MALFORMED, '']) {
    const listed = await post(page, 'mcp/bindingsList', { employeeId });
    expect(listed.status()).toBe(200);
    expect(((await listed.json()).json as { data: unknown[] }).data).toEqual([]);
  }
});

test('task writes shape-check assignee, owner and reviewer ids', async ({ page }) => {
  const employee = await createEmployee(page, 'task');
  const taskRes = await post(page, 'tasks/create', { title: `Id shape ${Date.now().toString(36)}` });
  expect(taskRes.status()).toBe(200);
  const taskId = (await taskRes.json()).json.id as string;

  await expectRpcError(
    page,
    'tasks/create',
    { title: 'bad assignee', assigneeId: MALFORMED },
    400,
    'assignee does not exist',
  );
  await expectRpcError(page, 'tasks/create', { title: 'bad owner', ownerId: MALFORMED }, 400, 'owner does not exist');
  await expectRpcError(
    page,
    'tasks/create',
    { title: 'bad reviewer', reviewers: [MALFORMED] },
    400,
    'reviewer does not exist',
  );
  await expectRpcError(page, 'tasks/update', { id: taskId, assigneeId: MALFORMED }, 400, 'assignee does not exist');
  await expectRpcError(page, 'tasks/update', { id: taskId, ownerId: MALFORMED }, 400, 'owner does not exist');
  await expectRpcError(page, 'tasks/update', { id: taskId, reviewers: [MALFORMED] }, 400, 'reviewer does not exist');

  // a valid-but-absent reference is the same BAD_REQUEST (an FK 500 is not the contract)
  await expectRpcError(
    page,
    'tasks/create',
    { title: 'absent assignee', assigneeId: ABSENT },
    400,
    'assignee does not exist',
  );

  // positive control: the very same writes with real ids still land
  const okTask = await post(page, 'tasks/create', {
    title: `Id shape ok ${Date.now().toString(36)}`,
    assigneeId: employee.id,
  });
  expect(okTask.status()).toBe(200);
  const okUpdate = await post(page, 'tasks/update', { id: taskId, title: 'renamed by id-shape' });
  expect(okUpdate.status()).toBe(200);
});

test('lookups keep their specced miss; the assignee filter keeps its empty page', async ({ page }) => {
  // a well-formed id with no row behind it: the lookup miss, not a shape error
  await expectRpcError(page, 'employees/createApiKey', { employeeId: ABSENT }, 404, 'employee not found');
  // blank is accepted at the schema edge and answered by the miss path
  await expectRpcError(page, 'employees/listApiKeys', { employeeId: '' }, 404, 'employee not found');

  // supervisor ids land in employee_supervisors.supervisor_id (uuid): a malformed
  // value is malformed input (its own message, so the pin cannot pass on the
  // roster-miss path), never a 22P02 500
  await expectRpcError(
    page,
    'employees/create',
    {
      name: 'Bad Sup',
      email: `bad-sup-${Date.now().toString(36)}@tandem.local`,
      kind: 'human',
      title: 'Tester',
      supervisorIds: [MALFORMED],
    },
    400,
    'invalid supervisor id',
  );

  // a canonical UPPERCASE id names the same employee (uuid columns compare
  // case-insensitively) — accepted, not reported as missing
  const boss = await createEmployee(page, 'boss');
  const upperSup = await post(page, 'employees/create', {
    name: 'Upper Sup',
    email: `upper-sup-${Date.now().toString(36)}@tandem.local`,
    kind: 'human',
    title: 'Tester',
    supervisorIds: [boss.id.toUpperCase()],
  });
  expect(upperSup.status()).toBe(200);

  // a filter is not a lookup — an unmatchable id answers the empty page
  const filtered = await post(page, 'tasks/listPaged', { assigneeId: MALFORMED });
  expect(filtered.status()).toBe(200);
  expect((await filtered.json()).json).toEqual({ data: [], total: 0 });
});

test('uuid case cannot bypass the self-supervision and self-delete guards', async ({ page }) => {
  const employee = await createEmployee(page, 'case');
  // uppercase target + lowercase supervisor is the SAME employee: the guard must
  // decide it in JS (400), not let Postgres' CHECK constraint raise a 500
  await expectRpcError(
    page,
    'employees/update',
    { id: employee.id.toUpperCase(), name: 'Case Probe', title: 'Tester', supervisorIds: [employee.id] },
    400,
    'cannot supervise themselves',
  );
  // the mirror case pins the supervisor-id canonicalization itself: lowercase
  // target + uppercase supervisor would slip past a case-sensitive self-check
  // and hit the no_self_supervision CHECK (23514 → 500)
  await expectRpcError(
    page,
    'employees/update',
    { id: employee.id, name: 'Case Probe', title: 'Tester', supervisorIds: [employee.id.toUpperCase()] },
    400,
    'cannot supervise themselves',
  );

  // the same case-insensitivity applies to the self-delete guard
  const sessionRes = await post(page, 'auth/session', null);
  const adminId = (await sessionRes.json()).json.user.id as string;
  await expectRpcError(page, 'employees/remove', { id: adminId.toUpperCase() }, 400, 'cannot delete your own account');
});

test('positive control: employee writes with a real id still land', async ({ page }) => {
  const employee = await createEmployee(page, 'ok');
  const res = await post(page, 'employees/update', {
    id: employee.id,
    name: 'Renamed',
    title: 'Tester',
    supervisorIds: [],
  });
  expect(res.status()).toBe(200);
});

test('task forward shape-checks the target employee id at the handler edge', async ({ page }) => {
  const employee = await createEmployee(page, 'fwd');
  const taskRes = await post(page, 'tasks/create', {
    title: `Id shape fwd ${Date.now().toString(36)}`,
    assigneeId: employee.id,
  });
  expect(taskRes.status()).toBe(200);
  const taskId = (await taskRes.json()).json.id as string;

  // the forward gate reads the status category and the current holder BEFORE it
  // resolves the target id — drive the task to waiting-answer so the malformed
  // value reaches the same lookup a real forward would (otherwise a state error
  // would mask the shape guard and the pin would be vacuous)
  const statusesRes = await post(page, 'statuses/list', null);
  const statuses = ((await statusesRes.json()).json ?? []) as { id: string; category: string }[];
  const working = statuses.find((s) => s.category === 'working');
  expect(working).toBeTruthy();
  const moved = await post(page, 'tasks/setStatus', { id: taskId, status: working!.id });
  expect(moved.status()).toBe(200);
  const asked = await post(page, 'tasks/ask', { taskId, body: 'id-shape forward probe' });
  expect(asked.status()).toBe(200);

  await expectRpcError(page, 'tasks/forward', { taskId, toEmployeeId: MALFORMED }, 400, 'employee does not exist');
});
