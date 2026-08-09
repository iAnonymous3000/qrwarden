import { expect, test, type Page, type Request } from "@playwright/test";

async function firstControlSnapshot(page: Page): Promise<unknown> {
  const evaluation = page.evaluate(async () => {
    const worker = (value: ServiceWorker | null): { scriptURL: string; state: ServiceWorkerState } | null =>
      value === null ? null : { scriptURL: value.scriptURL, state: value.state };
    let registration: unknown;
    try {
      const result = await Promise.race([
        navigator.serviceWorker.getRegistration().then((value) => ({ kind: "value" as const, value })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          window.setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);
      registration = result.kind === "timeout"
        ? { kind: "timeout" }
        : {
            kind: "value",
            active: worker(result.value?.active ?? null),
            installing: worker(result.value?.installing ?? null),
            waiting: worker(result.value?.waiting ?? null),
          };
    } catch (error) {
      registration = {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const strip = document.querySelector<HTMLElement>(".offline-strip");
    return {
      href: window.location.href,
      documentReadyState: document.readyState,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
      controller: worker(navigator.serviceWorker.controller),
      registration,
      offlineStrip: strip === null
        ? null
        : { className: strip.className, text: strip.textContent?.trim() ?? "" },
      fileInputDisabled: document.querySelector<HTMLInputElement>('input[type="file"]')?.disabled ?? null,
    };
  }).catch((error: unknown) => ({
    evaluationError: error instanceof Error ? error.message : String(error),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<{ evaluationTimeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ evaluationTimeout: true }), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  const pageErrors: string[] = [];
  const requestFailures: Array<{ url: string; errorText: string | null }> = [];
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  const onRequestFailed = (request: Request): void => {
    requestFailures.push({
      url: request.url(),
      errorText: request.failure()?.errorText ?? null,
    });
  };
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  try {
    await page.goto("/");
    // A cold first install fetches and verifies the whole precache before the
    // worker can claim the page. The inner deadline is a wedged-worker
    // backstop, and the retained snapshot below records which lifecycle slot
    // stalled.
    //
    // A per-test timeout does not replace this bounded controller check: the
    // poll owns its own failure and diagnostic boundary.
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
  } catch (error) {
    await test.info().attach("goto-controlled-failure.json", {
      body: JSON.stringify({
        snapshot: await firstControlSnapshot(page),
        pageErrors,
        requestFailures,
      }, null, 2),
      contentType: "application/json",
    });
    throw error;
  } finally {
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
  }
}
