import { BasePage } from './base.page.ts';

// Vault surface: create secrets and drive the secrets search box.
export class VaultPage extends BasePage {
  async createSecret(secret: { name: string; description?: string; value: string }): Promise<void> {
    await this.page.getByRole('button', { name: 'New secret' }).first().click();
    await this.page.getByRole('textbox', { name: 'Name' }).fill(secret.name);
    if (secret.description !== undefined) {
      await this.page.getByRole('textbox', { name: 'Description' }).fill(secret.description);
    }
    await this.page.getByRole('textbox', { name: 'Value' }).fill(secret.value);
    await this.page.getByRole('button', { name: 'Save' }).click();
  }

  async search(text: string): Promise<void> {
    await this.page.getByPlaceholder('Search secrets…').fill(text);
  }
}
