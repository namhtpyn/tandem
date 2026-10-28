import { expect, type Locator } from '@playwright/test';

import { BasePage } from './base.page.ts';

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
      await this.page.getByRole('combobox', { name: 'Assignee' }).click();
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
