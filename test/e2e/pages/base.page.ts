import { expect, type Locator, type Page } from '@playwright/test';

/** Hydration gate shared by login() and BasePage.navigate: the SSR'd buttons
 * exist before Vue attaches @click, so a click straight after a page load can
 * be swallowed. Returns when the app is interactive. */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    try {
      const nuxt = (window as Window & { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.();
      if (nuxt) return nuxt.isHydrating === false;
    } catch {
      // no nuxt context outside the app yet — fall through to the Vue stamp
    }
    const root = document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null;
    return Boolean(root?.__vue_app__);
  });
}

// Shared page plumbing for specs: plain navigation, modal/drawer dismissal,
// the two-step delete confirm, and the paged-list row search that employees/
// vault/providers/environments each grew an identical copy of.
export class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async navigate(path: string): Promise<void> {
    await this.page.goto(path);
    // a raw goto races hydration — every navigate is gated (see waitForHydration)
    await waitForHydration(this.page);
  }

  // Close an overlay with Escape, settled when the overlay's sentinel text no
  // longer reads from the body — polled, not slept, so it rides out the close
  // transition. A sentinel that also lives behind the overlay (e.g. the row's
  // own 'Edit employee' button) keeps the poll failing by design: the fallback
  // then tries the overlay's Close button, which no-ops when Escape already
  // closed it.
  async dismissOverlay(sentinelText: string): Promise<void> {
    await this.page.keyboard.press('Escape');
    try {
      await expect
        .poll(() => this.page.evaluate((t: string) => (document.body.innerText || '').includes(t), sentinelText), {
          timeout: 1_500,
        })
        .toBe(false);
    } catch {
      const close = this.page.getByRole('button', { name: 'Close' }).first();
      if (await close.count()) await close.click();
    }
  }

  // Second step of the two-step delete law: the row's delete button (clicked by
  // the caller) opens the dialog, this confirms it. .last() because stacked
  // overlays render the dialog last in the DOM.
  async confirmDelete(): Promise<void> {
    await this.page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  }

  // Server-paged lists surface fresh rows on page 1 via the debounced search
  // box; no settle sleep — the callers' retrying row asserts absorb the
  // debounced query + refetch.
  async searchRows(placeholder: string, text: string): Promise<void> {
    await this.page.getByPlaceholder(placeholder).fill(text);
  }
}
