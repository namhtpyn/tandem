import { expect, type Locator } from '@playwright/test';

import { BasePage } from './base.page.ts';

// MCP registry surface: create/edit/delete registry entries through the /mcp UI.
export class McpPage extends BasePage {
  // Navigate + gate on the admin navbar title (UDashboardNavbar renders it as
  // the page heading).
  async open(): Promise<void> {
    await this.navigate('/mcp');
    await expect(this.page.getByRole('heading', { name: 'MCP registry' })).toBeVisible();
  }

  // The registry row for an entry — :visible-filtered like every caller,
  // first() because live re-renders can briefly duplicate rows.
  rowFor(name: string): Locator {
    return this.page.locator('tr:visible').filter({ hasText: name }).first();
  }

  async createServer(server: { name: string; url: string; notes?: string }): Promise<void> {
    await this.page.getByRole('button', { name: 'New server' }).first().click();
    await this.page.getByRole('textbox', { name: 'Name' }).fill(server.name);
    await this.page.getByRole('textbox', { name: 'URL' }).fill(server.url);
    if (server.notes !== undefined) {
      await this.page.getByRole('textbox', { name: 'Notes' }).fill(server.notes);
    }
    await this.page.getByRole('button', { name: /Save changes|Create server/ }).click();
  }
}
