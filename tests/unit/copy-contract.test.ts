import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as copyModule from "../../src/copy";
import { COPY } from "../../src/copy";

const SOURCE_SHA256 =
  "2e949109ac28a01b9fd393d728c405e07051e7d0668a00fbd636de89e9a0ddea";
const RUNTIME_CONTRACT_SHA256 =
  "931daed9ff028a44f1b9ec1cb0714c50410d4aa380f1558b7dbb36b280066742";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function materialize(key: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "function") {
    throw new TypeError(`Unexpected copy export type for ${key}`);
  }
  switch (key) {
    case "reviewBody":
      return (value as (count: number) => string)(7);
    case "confirmBody":
    case "credentialsExplanation":
      return (value as (host: string) => string)("scan.example");
    default:
      throw new TypeError(`Copy function ${key} needs an explicit snapshot input`);
  }
}

describe("reviewed copy contract", () => {
  it("pluralizes review details for plain-language results", () => {
    expect(COPY.reviewBody(1)).toContain("1 detail to review");
    expect(COPY.reviewBody(2)).toContain("2 details to review");
  });

  it("snapshots every source byte, runtime export, key, and rendered string", async () => {
    const source = await readFile(
      new URL("../../src/copy/index.ts", import.meta.url),
    );
    const snapshot = Object.entries(COPY).map(([key, value]) => [
      key,
      materialize(key, value),
    ]);

    expect(Object.keys(copyModule)).toEqual(["COPY"]);
    expect(Object.isFrozen(COPY)).toBe(true);
    expect(snapshot).toHaveLength(92);
    expect(snapshot.every(([key, value]) => key.length > 0 && value.length > 0)).toBe(
      true,
    );
    expect(sha256(source)).toBe(SOURCE_SHA256);
    expect(sha256(JSON.stringify(snapshot))).toBe(RUNTIME_CONTRACT_SHA256);
  });
});
