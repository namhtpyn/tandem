import { expect, test } from '@playwright/test';

import { login } from './helpers/login.ts';

test('graph view renders the supervision hierarchy', async ({ page }) => {
  const suffix = Date.now().toString(36).slice(-6);
  await login(page);
  await page.goto('/employees');
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible();

  // supervisor first
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(`Gb ${suffix}`);
  await page.getByPlaceholder('name@company.com').fill(`gb-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('Lead');
  await page.getByRole('button', { name: /Create employee/ }).click();
  await expect(page.locator('tr:visible', { hasText: `Gb ${suffix}` })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done, key saved/ }).click();

  // report
  await page.getByRole('button', { name: 'New employee' }).first().click();
  await page.getByPlaceholder('Full name').fill(`Gs ${suffix}`);
  await page.getByPlaceholder('name@company.com').fill(`gs-${suffix}@tandem.local`);
  await page.getByRole('radio', { name: /Human/ }).check();
  await page.getByPlaceholder('Job title').fill('Dev');
  await page.getByRole('button', { name: 'Supervisors', exact: true }).click();
  await page.getByRole('option', { name: `Gb ${suffix}` }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Create employee/ }).click();
  await expect(page.locator('tr:visible', { hasText: `Gs ${suffix}` })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Done, key saved/ }).click();

  // graph view
  await page.getByRole('button', { name: 'Graph view' }).click();
  const svg = page.locator('svg[aria-label="Supervision hierarchy"]');
  await expect(svg).toBeVisible({ timeout: 10_000 });
  // the org chart pans horizontally — assert presence (text is clipped by the
  // scroll container when off-viewport, so count beats visibility)
  // node labels truncate at 14 chars + ellipsis — substring match
  await expect(svg.getByText(`Gb ${suffix}`.slice(0, 13))).toHaveCount(1);
  await expect(svg.getByText(`Gs ${suffix}`.slice(0, 13))).toHaveCount(1);
  // sub renders one depth below boss (top-down rows) with a connector
  const rows = await page.evaluate(
    ([boss, sub]) => {
      const el = document.querySelector('svg[aria-label="Supervision hierarchy"]');
      const gs = [...(el?.querySelectorAll('g') ?? [])].filter((g) => g.querySelector('rect'));
      const byName = (needle: string) =>
        gs.find((g) => [...g.querySelectorAll('text')].some((t) => t.textContent?.includes(needle)));
      const b = byName(boss)?.getAttribute('transform');
      const s = byName(sub)?.getAttribute('transform');
      const paths = el?.querySelectorAll('path').length ?? 0;
      return { b, s, paths };
    },
    [`Gb ${suffix}`, `Gs ${suffix}`],
  );
  expect(rows.s && rows.b).toBeTruthy();
  const by = Number(/translate\(([-\d.]+), ([-\d.]+)\)/.exec(rows.s!)![2]!);
  const bY = Number(/translate\(([-\d.]+), ([-\d.]+)\)/.exec(rows.b!)![2]!);
  expect(by).toBeGreaterThan(bY); // sub sits BELOW boss
  expect(rows.paths).toBeGreaterThan(0);
});
