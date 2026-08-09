import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The 90-day analyzer-data window is only enforced by
// validate-release-readiness.mjs, which runs inside the release workflow. A
// release dispatched after the window closes therefore fails deep inside the
// build job with no earlier warning. This runs in ordinary validation and
// reports the remaining margin, so the expiry is visible weeks ahead. It
// warns rather than fails: an expired snapshot must not block development,
// and the release gate is still the thing that refuses to ship it.
const WINDOW_DAYS = 90;
const WARN_WITHIN_DAYS = 21;

export function freshnessReport(data, now) {
  const sources = [
    ["Public Suffix List", data.publicSuffix?.captured],
    ["IANA special-purpose registries", data.ianaSpecialPurpose?.captured],
    ["Unicode security data", data.unicodeSecurity?.captured],
  ];
  return sources.map(([label, captured]) => {
    if (typeof captured !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(captured)) {
      return { label, captured: null, remainingDays: null, state: "invalid" };
    }
    const ageDays = (now - Date.parse(`${captured}T00:00:00Z`)) / 86_400_000;
    const remainingDays = Math.floor(WINDOW_DAYS - ageDays);
    const state =
      remainingDays < 0 ? "expired" : remainingDays <= WARN_WITHIN_DAYS ? "expiring" : "fresh";
    return { label, captured, remainingDays, state };
  });
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = JSON.parse(await readFile(path.join(root, "release/data-status.json"), "utf8"));
  const report = freshnessReport(data, Date.now());

  for (const entry of report) {
    if (entry.state === "invalid") {
      process.stderr.write(`data freshness: ${entry.label} capture date is missing or invalid\n`);
    } else if (entry.state === "expired") {
      process.stderr.write(
        `data freshness: ${entry.label} snapshot from ${entry.captured} is OUTSIDE the ${WINDOW_DAYS}-day release window by ${-entry.remainingDays} days; re-pull and run npm run data:generate before releasing\n`,
      );
    } else if (entry.state === "expiring") {
      process.stderr.write(
        `data freshness: ${entry.label} snapshot from ${entry.captured} leaves the release window in ${entry.remainingDays} days\n`,
      );
    }
  }

  const soonest = report
    .filter((entry) => entry.remainingDays !== null)
    .reduce((least, entry) => (least === null || entry.remainingDays < least ? entry.remainingDays : least), null);
  process.stdout.write(
    soonest === null
      ? "checked analyzer data freshness: no valid capture dates\n"
      : `checked analyzer data freshness: ${soonest} days of release window remaining\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
