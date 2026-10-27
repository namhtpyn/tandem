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
    await row.locator('button[aria-label="Task workflow"]').first().click();
    const drawer = this.page.locator('[data-slot="content"]').first();
    await expect(drawer).toBeVisible();
    return drawer;
  }
}
