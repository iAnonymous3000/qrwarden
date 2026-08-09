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
  //
  // Raised from 45s after the suite grew to 193 tests: on 2-core CI runners
  // three specs began needing their retry here, always at this poll and never
  // at an assertion, which means the install was still legitimately running
  // rather than wedged. A per-test timeout does not help — this is an inner
  // expect.poll with its own budget. The ceiling is a wedged-worker backstop,
  // not a target: a healthy install settles in about two seconds, so raising
  // it costs nothing on a passing run and only buys headroom on a loaded one.
  await expect
    .poll(
      () =>
        page
          .evaluate(() => navigator.serviceWorker.controller !== null)
          .catch(() => false),
      { timeout: 75_000 },
    )
    .toBe(true);
  await expect(page.locator('input[type="file"]').first()).toBeEnabled({
    timeout: 20_000,
  });
}
