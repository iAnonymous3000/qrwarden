import { expect, type Page } from "@playwright/test";

/**
 * Settles a first visit before a flow begins: the freshly installed service
 * worker must take control of the page (via clients.claim() or its fallback
 * reload) and the release gate must unlock. Interacting earlier races that
 * handoff, which closes open dialogs and briefly disables controls when it
 * lands mid-flow. The poll tolerates the fallback reload destroying the
 * evaluation context.
 *
 * Startup-state tests (locked shell, blocked storage, denied registration,
 * offline cold-launch) must NOT use this helper — the unsettled states are
 * what they assert.
 */
export async function gotoControlled(page: Page): Promise<void> {
  await page.goto("/");
  // A cold first install fetches and verifies the whole precache before the
  // worker can claim the page; on starved runners that alone can pass 20s.
  await expect
    .poll(
      () =>
        page
          .evaluate(() => navigator.serviceWorker.controller !== null)
          .catch(() => false),
      { timeout: 45_000 },
    )
    .toBe(true);
  await expect(page.locator('input[type="file"]').first()).toBeEnabled({
    timeout: 20_000,
  });
}
