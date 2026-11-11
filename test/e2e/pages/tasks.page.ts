import { expect, type Locator, type Page } from '@playwright/test';
import { SQL } from 'bun';

import { E2E_DATABASE_URL } from '../helpers/env.ts';
import { BasePage } from './base.page.ts';

/** hold the dispatcher scan off a fresh ready AI task: the 5s tick would claim
 *  it mid-test (create → page/drawer → manual dispatch crosses the scan) and the
 *  run settles before the spec's own click. The MANUAL verb ignores
 *  dispatch_after — only the scan (and the note path) respect it. A silent
 *  0-row UPDATE would let the scan in, so the update proves its own match (#387). */
export async function holdDispatchScan(taskId: string): Promise<void> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const held =
      await sql`update tasks set dispatch_after = now() + interval '15 minutes' where id = ${taskId} returning id`;
    expect(held.length, 'dispatch_after hold landed on the task').toBe(1);
  } finally {
    await sql.close();
  }
}

/** the seed's read state (fresh statement, real clock): the hold stands, the
 *  employee is the assignee, and that assignee is an AI employee — the scanner's
 *  eligibility is the ai_employees row, and a human user id attaches just as
 *  happily (200) while leaving the task permanently ineligible. */
async function dispatchHoldState(
  taskId: string,
  employeeId: string,
): Promise<{ held: boolean; attached: boolean; aiEmployee: boolean } | null> {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const rows = await sql`
      select (dispatch_after - now()) > interval '10 minutes' as held,
             assignee_id = ${employeeId} as attached,
             exists (select 1 from ai_employees where user_id = ${employeeId}) as ai_employee
      from tasks where id = ${taskId}`;
    if (rows.length === 0) return null;
    return {
      held: rows[0]!.held === true,
      attached: rows[0]!.attached === true,
      aiEmployee: rows[0]!.ai_employee === true,
    };
  } finally {
    await sql.close();
  }
}

/** read-back: every seed precondition holds — a silent no-op here re-opens the
 *  5s-scan claim window (hold) or leaves the verb unmountable (assignee kind) */
export async function expectDispatchHold(taskId: string, employeeId: string): Promise<void> {
  const state = await dispatchHoldState(taskId, employeeId);
  expect(state, 'task row exists for the seed read-back').not.toBeNull();
  expect(state!.held, 'dispatch_after hold has a real future margin').toBe(true);
  expect(state!.attached, 'seeded employee is the assignee').toBe(true);
  expect(state!.aiEmployee, 'seeded assignee is an AI employee (scanner-eligible kind)').toBe(true);
}

/** the task id a list row / title link points at; asserts the link SHAPE first
 *  (one `/tasks/<id>` segment, optional query) so a route regression fails at the
 *  parse site instead of as a 0-row seed, then strips the list-scope query the
 *  link may carry (a leftover `?scope=` silently misses every SQL key below) */
export async function rowTaskIdFromLink(link: Locator): Promise<string> {
  // the ATTRIBUTE assert retries (auto-waiting): a row re-rendering in the create
  // refetch wave must not fail the seed as a shape error
  const taskLink = /^\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?.*)?$/i;
  await expect(link, 'row links to the task page').toHaveAttribute('href', taskLink);
  const href = (await link.getAttribute('href')) as string;
  const taskId = href.split('?')[0]!.split('/').pop() as string;
  expect(taskId, 'task id from the row link').toBeTruthy();
  return taskId;
}

export async function rowTaskId(row: Locator): Promise<string> {
  return rowTaskIdFromLink(row.locator('a[href^="/tasks/"]').first());
}

/** attach an assignee through the RPC edge (no hold handling — a caller that
 *  needs the born-ineligible seed wants `attachAssigneeHeld`) */
export async function attachAssignee(page: Page, taskId: string, employeeId: string): Promise<void> {
  const res = await page.request.post('/rpc/tasks/update', { data: { json: { id: taskId, assigneeId: employeeId } } });
  expect(res.status(), 'assignee attach accepted').toBe(200);
}

/** BORN-INELIGIBLE SEED (#297, #387, #391): hold the scan, attach the AI
 *  assignee through the RPC edge, then re-hold IN THE SAME BEAT — the attach is
 *  the write that makes a ready task scanner-eligible, so a hold that does not
 *  survive it leaves a window where the 5s tick can claim the task. The re-hold is
 *  unconditional on purpose: a read-then-repair would put a page round-trip and a
 *  fresh DB connection between the write and the repair, and the read-back could
 *  not tell a clean seed from one the scan already claimed (a claim flips status
 *  and mints a RUNNING run without clearing dispatch_after). The read-back then
 *  proves the END state only: hold with margin + AI assignee. Whether an attach
 *  preserves dispatch_after stays unpinned (unspecced product detail). */
export async function attachAssigneeHeld(page: Page, taskId: string, employeeId: string): Promise<void> {
  await holdDispatchScan(taskId);
  await attachAssignee(page, taskId, employeeId);
  await holdDispatchScan(taskId);
  await expectDispatchHold(taskId, employeeId);
}

/** BORN-INELIGIBLE SEEDING (#297, #387, #391): a task created WITH the AI assignee
 *  is scanner-eligible at insert, so the 5s dispatch tick can claim it while the
 *  page/drawer settles — the dispatch verb unmounts mid-click and Playwright waits
 *  60s on a button that never returns. Create it unassigned, hold dispatch_after,
 *  then attach the assignee through the RPC edge: the scan AND the note path
 *  respect the hold; only the manual Dispatch-now verb ignores it, which is the
 *  verb these specs drive. Returns the created list row. */
export async function createTaskWithHeldScan(
  page: Page,
  tasks: TasksPage,
  title: string,
  employeeId: string,
): Promise<Locator> {
  await tasks.navigate('/tasks');
  await tasks.openCreateModal();
  await tasks.fillTaskForm({ title });
  await tasks.saveTask();
  const row = tasks.rowFor(title);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const taskId = await rowTaskId(row);
  await attachAssigneeHeld(page, taskId, employeeId);
  return row;
}

/** the committed EVENT of a round open: the task_reviews rows of THAT round,
 *  never a transient status badge (the server can move a task through `in review`
 *  and out again before the client's first post-verb refetch — #375, #416).
 *  `round` is REQUIRED: counting any row for the task would pass on a round an
 *  earlier call site already opened, pinning nothing at this call. */
export async function expectRoundOpened(taskId: string, opts: { round: number; timeout?: number }): Promise<void> {
  await expect
    .poll(
      async () => {
        const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
        try {
          const rows =
            await sql`select count(*)::int as n from task_reviews where task_id = ${taskId} and round = ${opts.round}`;
          return Number(rows[0]?.n ?? 0);
        } finally {
          await sql.close();
        }
      },
      {
        timeout: opts.timeout ?? 15_000,
        message: `round ${opts.round} opened for the task (task_reviews row)`,
      },
    )
    .toBeGreaterThan(0);
}

// Tasks surface: the create/edit modal and the workflow drawer used by the
// tasks spec (small task-* specs keep inline locators on purpose).
export class TasksPage extends BasePage {
  async openCreateModal(): Promise<void> {
    await this.page.getByRole('button', { name: 'New task' }).first().click();
  }

  async fillTaskForm(task: { title: string; description?: string; assignee?: string }): Promise<void> {
    await this.page.getByPlaceholder('Task title').fill(task.title);
    if (task.description !== undefined) {
      await this.page.locator('[contenteditable]').first().fill(task.description);
    }
    if (task.assignee !== undefined) {
      // scope to the modal: list rows now carry `Assignee for <title>` comboboxes
      await this.page.getByRole('dialog').getByRole('combobox', { name: 'Assignee', exact: true }).click();
      await this.page.getByRole('option', { name: task.assignee }).click();
    }
  }

  async saveTask(): Promise<void> {
    await this.page.getByRole('button', { name: /Save|Create task/ }).click();
  }

  async createTask(task: { title: string; description?: string; assignee?: string }): Promise<void> {
    await this.openCreateModal();
    await this.fillTaskForm(task);
    await this.saveTask();
  }

  // The task's list row — :visible-filtered like every caller, first() because
  // live re-renders can briefly duplicate rows.
  rowFor(title: string): Locator {
    return this.page.locator('tr:visible').filter({ hasText: title }).first();
  }

  // Opens the workflow drawer for the row and returns the drawer panel; the
  // callers keep their own visibility/content assertions on it.
  async openWorkflowDrawer(row: Locator): Promise<Locator> {
    await row
      .getByRole('button', { name: /Workflow for/ })
      .first()
      .click();
    const drawer = this.page.getByRole('dialog', { name: 'Task workflow' });
    await expect(drawer).toBeVisible();
    return drawer;
  }

  // Teardown helper: surface the run's task via the list search and delete it
  // through the two-step confirm — fixed-title leftovers must not pollute the
  // shared e2e DB.
  async deleteTask(title: string): Promise<void> {
    await this.page.goto('/tasks');
    const search = this.page.getByRole('textbox', { name: 'Search tasks' });
    await search.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await search.isVisible()) await search.fill(title);
    const row = this.page.locator('tr:visible', { hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /Delete / }).click();
    await this.page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(this.page.locator('tr:visible', { hasText: title })).toHaveCount(0, { timeout: 15_000 });
  }
}
