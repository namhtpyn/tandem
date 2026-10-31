// #99: the List/Board view toggle used to live inside the toolbar's
// right-aligned overflow scroller — at 390×844 it rendered outside the visible
// row and board view had NO touch entry point (Playwright hit-target retries
// until timeout). SPEC /tasks: the toggle is pinned OUTSIDE the action
// scroller — always visible at phone widths, ≥44px targets, no horizontal
// scrolling to reach it (MOBILE-FIRST law).
import { expect, test } from './helpers/cleanup';
import { TasksPage } from './pages/tasks.page.ts';

test.use({ viewport: { width: 390, height: 844 } });

test('view toggle is visible and tappable at 390×844', async ({ page }) => {
  const tasks = new TasksPage(page);
  await tasks.navigate('/tasks');

  const list = page.getByRole('button', { name: 'List view' });
  const board = page.getByRole('button', { name: 'Board view' });

  for (const toggle of [list, board]) {
    await expect(toggle).toBeVisible();
    // 44px phone tap target (MOBILE-FIRST law) — h-11 at phone widths
    await expect(toggle).toHaveCSS('height', '44px');
    // inside the visible row: no horizontal scrolling to reach it
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }

  // the actual regression: board view is reachable by touch
  await board.click();
  await expect(page.getByTestId('board-column').first()).toBeVisible();
  await expect(board).toHaveAttribute('aria-pressed', 'true');
  await expect(list).toHaveAttribute('aria-pressed', 'false');

  // …and back to list, same tap
  await list.click();
  await expect(page.getByTestId('board-column')).toHaveCount(0);
  await expect(list).toHaveAttribute('aria-pressed', 'true');
});
