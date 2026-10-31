// #103: at 390×844 the status tab strip clipped its trailing tab and the
// toolbar action scroller hard-cut "New task" at full opacity — neither read
// as scrollable — while every chip/button in both rows measured 28px tall
// (under the 44px MOBILE-FIRST minimum; #99 fixed only the view toggle).
// SPEC /tasks: every horizontally scrollable control row in the toolbar area
// carries a right-edge scroll affordance (fade mask) and every control in them
// exposes a ≥44px touch target at phone widths, visual size unchanged from sm.
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test.use({ viewport: { width: 390, height: 844 } });

test('status strip + toolbar scroller: affordance and 44px targets at 390×844', async ({ page }) => {
  const tasks = new TasksPage(page);
  await tasks.navigate('/tasks');

  const strip = page.getByRole('group', { name: 'Filter by status' });
  await expect(strip).toBeVisible();

  // the strip genuinely overflows at phone width — scrolling is required
  const overflow = await strip.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    mask: getComputedStyle(el).maskImage,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  // right-edge fade is present (the scroll affordance the audit found missing)
  expect(overflow.mask).not.toBe('none');

  // every status tab: 44px touch target at phone width (h-11)…
  const tabs = strip.getByRole('button');
  const tabCount = await tabs.count();
  expect(tabCount).toBeGreaterThan(1); // All + seeded statuses
  for (let i = 0; i < tabCount; i++) {
    await expect(tabs.nth(i)).toHaveCSS('height', '44px');
  }

  // …and the trailing tab is fully revealable by scroll (peek padding keeps it
  // clear of the fade) — the regression behind "clipped mid-glyph"
  const last = tabs.nth(tabCount - 1);
  const lastLabel = (await last.textContent())!.trim();
  await last.scrollIntoViewIfNeeded();
  const revealed = await last.evaluate((el) => {
    const scroller = el.closest('[aria-label="Filter by status"]') as HTMLElement;
    const box = el.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    return { right: box.right, frameRight: frame.right, scrollLeft: scroller.scrollLeft };
  });
  expect(revealed.scrollLeft).toBeGreaterThan(0);
  expect(revealed.right).toBeLessThanOrEqual(revealed.frameRight + 1);

  // the tap works at phone size: filtering by the trailing status toggles it
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');

  // toolbar action scroller: same affordance + 44px chips (Decisions/Awaiting)
  const decisions = page.getByRole('button', { name: 'Needs my decision' });
  const awaiting = page.getByRole('button', { name: 'Awaiting decision' });
  for (const chip of [decisions, awaiting]) {
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('height', '44px');
  }
  const scroller = await decisions.evaluate((el) => {
    const row = el.parentElement as HTMLElement;
    return { mask: getComputedStyle(row).maskImage, overflowX: getComputedStyle(row).overflowX };
  });
  expect(scroller.overflowX).toBe('auto');
  expect(scroller.mask).not.toBe('none');

  // smoke: the tapped filter applied — All released the pressed state
  await expect(strip.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  expect(lastLabel.length).toBeGreaterThan(0);
});
