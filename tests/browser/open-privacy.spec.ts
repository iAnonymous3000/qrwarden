import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { expect, test } from "@playwright/test";

import { COPY } from "../../src/copy";
import { gotoControlled } from "./support";

const fixture = new URL("../corpus/open-target.png", import.meta.url).pathname;
// The endpoint is baked into the committed symbol, so the sink cannot fall back
// to an ephemeral port.
const SINK_PORT = 4319;
const destination = `http://127.0.0.1:${SINK_PORT}/opened?probe=qrwarden`;

interface SinkRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

const received: SinkRequest[] = [];
let sink: Server;

test.beforeAll(async () => {
  // A retry that reuses this worker must not inherit the earlier attempt's
  // ledger, or the pre-click zero check reports a leak that never happened.
  received.length = 0;
  sink = createServer((request, response) => {
    received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    });
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("opened\n");
  });
  await new Promise<void>((resolve, reject) => {
    sink.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${SINK_PORT} is already in use, so the Open action could reach a foreign listener instead of this test's sink. Free the port and rerun.`,
            )
          : error,
      );
    });
    // Loopback only: this sink must never be reachable off-host.
    sink.listen(SINK_PORT, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  // Chromium leaves keep-alive sockets behind, which would stall close().
  sink.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    sink.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test("reaches the destination only on an explicit open, and without referrer or opener", async ({
  context,
  page,
}) => {
  await gotoControlled(page);
  await page.locator('input[type="file"]').setInputFiles(fixture);

  await expect(page.getByRole("heading", { name: COPY.reviewHeading })).toBeVisible({
    timeout: 15_000,
  });
  // Decoding and reporting are the whole product claim: reading the code must
  // not touch the network the code points at.
  expect(received).toEqual([]);

  const continueButton = page.getByRole("button", { name: COPY.continueToLink });
  await continueButton.click();
  const dialog = page.getByRole("dialog", { name: COPY.confirmHeading });
  await expect(dialog.locator(".confirm-full-url bdi")).toHaveText(destination);
  // Opening the confirmation is not yet consent to leave the device.
  expect(received).toEqual([]);

  const openedPage = context.waitForEvent("page");
  await dialog.getByRole("button", { name: COPY.openLink }).click();
  const opened = await openedPage;
  await opened.waitForLoadState();

  expect(opened.url()).toBe(destination);
  expect(await opened.evaluate(() => window.opener === null)).toBe(true);

  // Firefox fetches the destination's favicon; Chromium and WebKit do not. That
  // request is issued by the opened document on its own behalf, so only the
  // rest is attributable to QRWarden.
  const attributable = (): readonly SinkRequest[] =>
    received.filter((entry) => entry.url !== "/favicon.ico");
  await expect
    .poll(() => attributable().map((entry) => `${entry.method} ${entry.url}`))
    .toEqual(["GET /opened?probe=qrwarden"]);

  const [request] = attributable();
  if (request === undefined) throw new Error("Missing recorded sink request");
  const headers = new Map(
    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value] as const),
  );
  expect(headers.get("referer") ?? "").toBe("");
  expect(headers.has("cookie")).toBe(false);

  // Nothing the destination goes on to request may learn the app origin either.
  const appOrigin = new URL(page.url()).origin;
  for (const entry of received) {
    expect(entry.headers.referer ?? "").not.toContain(appOrigin);
    expect(entry.headers.cookie).toBeUndefined();
  }
});
