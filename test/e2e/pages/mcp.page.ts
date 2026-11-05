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

  // slice 3 stdio create: the transport select swaps the URL field for the
  // command/args/credential-env-var block (SPEC "stdio transport")
  async createStdioServer(server: {
    name: string;
    command: string;
    args?: string;
    credentialEnvVar?: string;
    notes?: string;
  }): Promise<void> {
    await this.page.getByRole('button', { name: 'New server' }).first().click();
    await this.page.getByRole('textbox', { name: 'Name' }).fill(server.name);
    await this.page.getByTestId('mcp-transport').click();
    await this.page.getByRole('option', { name: /stdio \(command\)/ }).click();
    await this.page.getByRole('textbox', { name: 'Command' }).fill(server.command);
    if (server.args !== undefined) await this.page.getByRole('textbox', { name: 'Arguments' }).fill(server.args);
    if (server.credentialEnvVar !== undefined)
      await this.page.getByRole('textbox', { name: 'Credential env var' }).fill(server.credentialEnvVar);
    if (server.notes !== undefined) {
      await this.page.getByRole('textbox', { name: 'Notes' }).fill(server.notes);
    }
    await this.page.getByRole('button', { name: /Save changes|Create server/ }).click();
  }
}
